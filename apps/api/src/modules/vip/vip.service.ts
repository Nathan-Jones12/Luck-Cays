/**
 * VIP rewards: points for wagering, five tiers, and the three perks the PRD lists -
 * a level-up chip bonus, a daily-bonus multiplier, and weekly cashback on net losses.
 *
 * Points accrue on every settled bet across all four games. `recordWager` is called
 * by the slots, sports and poker services after chips have actually moved, never
 * before - a bet that was rejected must not earn VIP progress.
 */
import type { VipProgress as VipProgressDto, VipTier as VipTierDto } from "@luck-cays/shared";
import { notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma, type Tx } from "../../lib/prisma.js";
import { CONFIG_KEYS, getChips, getInt } from "../config/config.service.js";
import { credit } from "../wallet/wallet.service.js";

/** The tier ladder, seeded into `vip_tiers`. Thresholds and perks live in the table. */
export const DEFAULT_TIERS = [
  { id: 1, name: "Bronze", minPoints: 0, dailyMultiplierBp: 100, levelupBonus: 0n, cashbackPct: 0 },
  {
    id: 2,
    name: "Silver",
    minPoints: 1_000,
    dailyMultiplierBp: 110,
    levelupBonus: 5_000n,
    cashbackPct: 2,
  },
  {
    id: 3,
    name: "Gold",
    minPoints: 10_000,
    dailyMultiplierBp: 125,
    levelupBonus: 25_000n,
    cashbackPct: 5,
  },
  {
    id: 4,
    name: "Platinum",
    minPoints: 50_000,
    dailyMultiplierBp: 150,
    levelupBonus: 100_000n,
    cashbackPct: 8,
  },
  {
    id: 5,
    name: "Diamond",
    minPoints: 250_000,
    dailyMultiplierBp: 200,
    levelupBonus: 500_000n,
    cashbackPct: 12,
  },
] as const;

export async function ensureProgress(userId: string, tx?: Tx): Promise<void> {
  const client = tx ?? prisma;
  const existing = await client.vipProgress.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (existing) return;

  await client.vipProgress.create({
    data: { userId, lifetimePoints: 0n, tierId: 1, weekNetLoss: 0n, weekStartedAt: new Date() },
  });
}

async function tiers(): Promise<
  Array<{
    id: number;
    name: string;
    minPoints: number;
    dailyMultiplierBp: number;
    levelupBonus: bigint;
    cashbackPct: number;
  }>
> {
  return prisma.vipTier.findMany({ orderBy: { minPoints: "asc" } });
}

function tierForPoints<T extends { minPoints: number }>(ladder: T[], points: bigint): T {
  // Ladder is ascending, so the last tier whose threshold we have met is ours.
  let current = ladder[0] as T;
  for (const tier of ladder) {
    if (BigInt(tier.minPoints) <= points) current = tier;
  }
  return current;
}

/* -------------------------------- accrual ---------------------------------- */

export interface WagerOutcome {
  pointsAwarded: number;
  lifetimePoints: bigint;
  /** Set when this wager pushed the player into a new tier. */
  leveledUpTo?: string;
  /** Chips granted for the level-up, if any. */
  levelupBonus?: bigint;
}

/**
 * Record chips wagered and chips won, then move VIP state accordingly.
 *
 * `wagered` drives points. `netLoss` (wagered minus won, floored at zero) accumulates
 * toward weekly cashback. Both are taken from the settled result so a push or a void
 * contributes nothing.
 *
 * The level-up bonus is credited through the wallet like any other movement, so it
 * lands in the ledger as a `vip_reward`.
 */
export async function recordWager(
  userId: string,
  wagered: bigint,
  won: bigint,
): Promise<WagerOutcome> {
  await ensureProgress(userId);

  const chipsPerPoint = await getChips(CONFIG_KEYS.vipPointsPerChips);
  const weekDays = await getInt(CONFIG_KEYS.cashbackWeekDays);

  const progress = await prisma.vipProgress.findUniqueOrThrow({
    where: { userId },
    select: { lifetimePoints: true, tierId: true, weekNetLoss: true, weekStartedAt: true },
  });

  // Integer division: 150 chips at 100 per point earns 1 point, not 1.5.
  const pointsAwarded = chipsPerPoint > 0n ? Number(wagered / chipsPerPoint) : 0;
  const lifetimePoints = progress.lifetimePoints + BigInt(pointsAwarded);

  // Roll the cashback week over if it has elapsed, rather than letting losses pile up
  // indefinitely into one enormous payout.
  const weekElapsed = Date.now() - progress.weekStartedAt.getTime() >= weekDays * 86_400_000;

  const roundNetLoss = wagered > won ? wagered - won : 0n;
  const weekNetLoss = weekElapsed ? roundNetLoss : progress.weekNetLoss + roundNetLoss;

  const ladder = await tiers();
  const newTier = tierForPoints(ladder, lifetimePoints);
  const leveledUp = newTier.id > progress.tierId;

  await prisma.vipProgress.update({
    where: { userId },
    data: {
      lifetimePoints,
      tierId: newTier.id,
      weekNetLoss,
      ...(weekElapsed ? { weekStartedAt: new Date() } : {}),
    },
  });

  if (!leveledUp) return { pointsAwarded, lifetimePoints };

  let granted: bigint | undefined;
  if (newTier.levelupBonus > 0n) {
    // Keyed on the tier, so reaching Gold can only ever pay its bonus once.
    const result = await credit({
      userId,
      amount: newTier.levelupBonus,
      type: "vip_reward",
      refType: "vip_levelup",
      refId: String(newTier.id),
      idempotencyKey: `vip-levelup-${userId}-${newTier.id}`,
    });
    if (!result.replayed) {
      granted = newTier.levelupBonus;
      await prisma.bonusClaim.create({
        data: { userId, bonusType: "levelup", amount: newTier.levelupBonus },
      });
    }
  }

  logger.info({ userId, tier: newTier.name, pointsAwarded }, "vip tier up");

  return {
    pointsAwarded,
    lifetimePoints,
    leveledUpTo: newTier.name,
    ...(granted === undefined ? {} : { levelupBonus: granted }),
  };
}

/** The daily-bonus multiplier for a player's current tier, as a decimal. */
export async function dailyMultiplier(userId: string): Promise<number> {
  await ensureProgress(userId);
  const progress = await prisma.vipProgress.findUnique({
    where: { userId },
    select: { tier: { select: { dailyMultiplierBp: true } } },
  });
  return (progress?.tier.dailyMultiplierBp ?? 100) / 100;
}

/* --------------------------------- reads ----------------------------------- */

function toTierDto(tier: {
  id: number;
  name: string;
  minPoints: number;
  dailyMultiplierBp: number;
  levelupBonus: bigint;
  cashbackPct: number;
}): VipTierDto {
  return {
    id: tier.id,
    name: tier.name as VipTierDto["name"],
    minPoints: tier.minPoints,
    dailyMultiplier: tier.dailyMultiplierBp / 100,
    levelupBonus: tier.levelupBonus.toString(10),
    cashbackPct: tier.cashbackPct,
  };
}

export async function getProgress(userId: string): Promise<VipProgressDto> {
  await ensureProgress(userId);

  const progress = await prisma.vipProgress.findUnique({
    where: { userId },
    select: { lifetimePoints: true, tierId: true, weekNetLoss: true },
  });
  if (!progress) throw notFound("VIP progress not found", "VIP_PROGRESS_NOT_FOUND");

  const ladder = await tiers();
  const current =
    ladder.find((tier) => tier.id === progress.tierId) ?? (ladder[0] as (typeof ladder)[number]);
  const next = ladder.find((tier) => tier.minPoints > current.minPoints) ?? null;

  const points = progress.lifetimePoints;
  const pointsToNextTier = next ? BigInt(next.minPoints) - points : 0n;

  // Progress through the current band, for the progress bar. Diamond is full.
  const bandSize = next ? next.minPoints - current.minPoints : 0;
  const intoBand = Number(points - BigInt(current.minPoints));
  const tierProgress = bandSize > 0 ? Math.min(1, Math.max(0, intoBand / bandSize)) : 1;

  const pendingCashback = (progress.weekNetLoss * BigInt(current.cashbackPct)) / 100n;

  return {
    lifetimePoints: Number(points),
    tier: toTierDto(current),
    nextTier: next ? toTierDto(next) : null,
    pointsToNextTier: Number(pointsToNextTier > 0n ? pointsToNextTier : 0n),
    tierProgress,
    weekNetLoss: progress.weekNetLoss.toString(10),
    pendingCashback: pendingCashback.toString(10),
  };
}

export async function listTiers(): Promise<VipTierDto[]> {
  return (await tiers()).map(toTierDto);
}

/* ------------------------------- cashback job ------------------------------ */

export interface CashbackRun {
  considered: number;
  paid: number;
  totalChips: bigint;
}

/**
 * Pay weekly cashback on net losses and start a fresh week.
 *
 * Run by the scheduled job in `jobs/cashback.job.ts`. The idempotency key includes the
 * week-start timestamp, so a double run in the same week pays nothing twice.
 */
export async function payWeeklyCashback(now = new Date()): Promise<CashbackRun> {
  const weekDays = await getInt(CONFIG_KEYS.cashbackWeekDays);
  const cutoff = new Date(now.getTime() - weekDays * 86_400_000);

  const due = await prisma.vipProgress.findMany({
    where: { weekStartedAt: { lte: cutoff }, weekNetLoss: { gt: 0n } },
    select: {
      userId: true,
      weekNetLoss: true,
      weekStartedAt: true,
      tier: { select: { cashbackPct: true, name: true } },
    },
  });

  let paid = 0;
  let totalChips = 0n;

  for (const row of due) {
    const amount = (row.weekNetLoss * BigInt(row.tier.cashbackPct)) / 100n;

    if (amount > 0n) {
      const result = await credit({
        userId: row.userId,
        amount,
        type: "vip_reward",
        refType: "vip_cashback",
        refId: row.weekStartedAt.toISOString(),
        idempotencyKey: `vip-cashback-${row.userId}-${row.weekStartedAt.getTime()}`,
      });

      if (!result.replayed) {
        await prisma.bonusClaim.create({
          data: { userId: row.userId, bonusType: "cashback", amount },
        });
        paid += 1;
        totalChips += amount;
      }
    }

    await prisma.vipProgress.update({
      where: { userId: row.userId },
      data: { weekNetLoss: 0n, weekStartedAt: now },
    });
  }

  logger.info({ considered: due.length, paid, totalChips: totalChips.toString() }, "cashback run");
  return { considered: due.length, paid, totalChips };
}
