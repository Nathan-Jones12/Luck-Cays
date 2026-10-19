/**
 * VIP: lifetime points decide the tier, and the tier decides the daily lossback rate.
 *
 * Lossback = (amount wagered - total wins) x tier rate, over the period since the last daily
 * payout, on the games listed in config `vip.lossback_games`. Paid by jobs/lossback.ts.
 * A winning period pays nothing and nothing carries over.
 */
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getConfig, getLossbackSettings } from "./config.js";
import { pool } from "./db.js";
import { nextDailyTime } from "./time.js";

/** One tier as the frontend's vipTierSchema expects it (src/shared/schemas/vip.ts). */
export interface VipTierDto {
  id: number;
  name: string;
  minPoints: number;
  dailyMultiplier: number;
  levelupBonus: string;
  lossbackBp: number;
}

/** A player's standing, as the frontend's vipProgressSchema expects it. */
export interface VipProgressDto {
  lifetimePoints: number;
  tier: VipTierDto;
  nextTier: VipTierDto | null;
  pointsToNextTier: number;
  tierProgress: number;
  periodWagered: string;
  periodWon: string;
  periodNetLoss: string;
  pendingLossback: string;
  nextPayoutAt: string;
}

function toTierDto(row: RowDataPacket): VipTierDto {
  return {
    id: row.id as number,
    name: row.name as string,
    minPoints: row.min_points as number,
    dailyMultiplier: (row.daily_multiplier_bp as number) / 100,
    levelupBonus: String(row.levelup_bonus),
    lossbackBp: row.lossback_bp as number,
  };
}

/** The tier ladder, lowest first. */
export async function getTiers(): Promise<VipTierDto[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, name, min_points, daily_multiplier_bp, levelup_bonus, lossback_bp FROM vip_tiers ORDER BY min_points",
  );
  return rows.map(toTierDto);
}

function tierForPoints(ladder: VipTierDto[], points: bigint): VipTierDto {
  let current = ladder[0];
  for (const tier of ladder) if (BigInt(tier.minPoints) <= points) current = tier;
  if (!current) throw new Error("vip_tiers is empty - run db/seed.sql");
  return current;
}

/** Lossback owed on a period: (wagered - won) x rate, floored to whole chips; never negative. */
export function lossbackFor(wagered: bigint, won: bigint, lossbackBp: number): bigint {
  const netLoss = wagered - won;
  if (netLoss <= 0n) return 0n;
  return (netLoss * BigInt(lossbackBp)) / 10_000n;
}

export interface BetRecord {
  userId: string;
  /** "slots", "sports", "poker"... compared with config vip.lossback_games. */
  game: string;
  /** Chips staked. */
  wagered: bigint;
  /** Chips paid back (0 on a loss). For sports, record the stake when the bet is placed and
   *  the win when it settles, as two calls. */
  won: bigint;
}

/**
 * Records a settled bet for VIP: awards points on the stake and adds to the lossback period.
 * Call inside the same transaction that moved the chips, AFTER the wallet was locked.
 */
export async function recordBet(conn: PoolConnection, bet: BetRecord): Promise<void> {
  const [ladder, settings, lcPerPoint] = await Promise.all([
    getTiers(),
    getLossbackSettings(),
    getConfig("vip.lc_per_point", "100"),
  ]);
  const lowest = tierForPoints(ladder, 0n);

  await conn.query("INSERT IGNORE INTO vip_progress (user_id, tier_id) VALUES (?, ?)", [
    bet.userId,
    lowest.id,
  ]);
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT lifetime_points FROM vip_progress WHERE user_id = ? FOR UPDATE",
    [bet.userId],
  );
  const points = BigInt(rows[0]?.lifetime_points as string) + bet.wagered / BigInt(lcPerPoint);
  const tier = tierForPoints(ladder, points);
  const counts = settings.games.includes(bet.game);

  await conn.query(
    `UPDATE vip_progress
        SET lifetime_points = ?, tier_id = ?,
            period_wagered = period_wagered + ?, period_won = period_won + ?
      WHERE user_id = ?`,
    [
      points.toString(),
      tier.id,
      counts ? bet.wagered.toString() : "0",
      counts ? bet.won.toString() : "0",
      bet.userId,
    ],
  );
}

/** A player's tier, progress and pending lossback, or null if they have never bet. */
export async function getProgress(userId: string, now = new Date()): Promise<VipProgressDto | null> {
  const [[rows], ladder, settings] = await Promise.all([
    pool.query<RowDataPacket[]>(
      "SELECT lifetime_points, tier_id, period_wagered, period_won FROM vip_progress WHERE user_id = ?",
      [userId],
    ),
    getTiers(),
    getLossbackSettings(),
  ]);
  const row = rows[0];
  if (!row) return null;

  const points = BigInt(row.lifetime_points as string);
  const tier = ladder.find((t) => t.id === row.tier_id) ?? tierForPoints(ladder, points);
  const nextTier = ladder.find((t) => t.minPoints > tier.minPoints) ?? null;
  const wagered = BigInt(row.period_wagered as string);
  const won = BigInt(row.period_won as string);
  const netLoss = wagered > won ? wagered - won : 0n;

  const span = nextTier ? nextTier.minPoints - tier.minPoints : 0;
  const into = Number(points) - tier.minPoints;

  return {
    lifetimePoints: Number(points),
    tier,
    nextTier,
    pointsToNextTier: nextTier ? Math.max(0, nextTier.minPoints - Number(points)) : 0,
    tierProgress: nextTier ? Math.min(1, Math.max(0, into / span)) : 1,
    periodWagered: wagered.toString(),
    periodWon: won.toString(),
    periodNetLoss: netLoss.toString(),
    pendingLossback: lossbackFor(wagered, won, tier.lossbackBp).toString(),
    nextPayoutAt: nextDailyTime(now, settings.time, settings.timeZone).toISOString(),
  };
}
