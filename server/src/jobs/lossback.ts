/**
 * Daily lossback: at the configured time (default 14:00 America/Nassau), every player is
 * credited (wagered - won) x their tier's rate for the period since their last payout, and
 * the period restarts.
 *
 * Safe to run any number of times, from any number of server instances:
 *  - a player is paid only if their period started before the latest payout time, and
 *    paying them moves their period start to that time, inside one locked transaction;
 *  - the ledger entry carries the key `lossback:<user>:<date>`, so even a replay of the same
 *    day can never credit twice.
 *
 * If the server was down at 2pm, the next run pays on start-up. If it was down across
 * several 2pms, the missed days are paid together as one period at the current tier's rate.
 *
 * Bets placed between 2pm and the moment the job reaches a player (normally under a minute)
 * count toward the period being paid rather than the next one.
 */
import type { RowDataPacket } from "mysql2/promise";
import { getLossbackSettings } from "../config.js";
import { pool } from "../db.js";
import { lastDailyTime, localDateKey } from "../time.js";
import { lockWallet, credit } from "../wallet.js";
import { lossbackFor } from "../vip.js";

export interface LossbackRun {
  payoutTime: string;
  playersChecked: number;
  playersPaid: number;
  chipsPaid: string;
  failures: number;
}

export async function payDailyLossback(now = new Date()): Promise<LossbackRun> {
  const settings = await getLossbackSettings();
  const payoutTime = lastDailyTime(now, settings.time, settings.timeZone);
  const dateKey = localDateKey(payoutTime, settings.timeZone);

  const [due] = await pool.query<RowDataPacket[]>(
    "SELECT user_id FROM vip_progress WHERE period_started_at < ?",
    [payoutTime],
  );

  const run: LossbackRun = {
    payoutTime: payoutTime.toISOString(),
    playersChecked: due.length,
    playersPaid: 0,
    chipsPaid: "0",
    failures: 0,
  };
  let total = 0n;

  for (const { user_id: userId } of due as { user_id: string }[]) {
    try {
      const paid = await payPlayer(userId, payoutTime, dateKey);
      if (paid > 0n) {
        run.playersPaid += 1;
        total += paid;
      }
    } catch (err) {
      // One player's failure must not stop everyone else's payout. They stay due, so the
      // next run retries them.
      run.failures += 1;
      console.error(`[lossback] failed for user ${userId}:`, err);
    }
  }

  run.chipsPaid = total.toString();
  return run;
}

/** Pays one player and closes their period. Returns the chips credited (0 if nothing owed). */
async function payPlayer(userId: string, payoutTime: Date, dateKey: string): Promise<bigint> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Wallet first, then vip_progress - the same lock order as gameplay (see wallet.ts).
    const wallet = await lockWallet(conn, userId);
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT p.period_wagered, p.period_won, p.period_started_at, t.lossback_bp
         FROM vip_progress p JOIN vip_tiers t ON t.id = p.tier_id
        WHERE p.user_id = ? FOR UPDATE`,
      [userId],
    );
    const row = rows[0];

    // Re-checked under the lock: another run may have paid this player since the SELECT.
    if (!row || (row.period_started_at as Date).getTime() >= payoutTime.getTime()) {
      await conn.rollback();
      return 0n;
    }

    const amount = lossbackFor(
      BigInt(row.period_wagered as string),
      BigInt(row.period_won as string),
      row.lossback_bp as number,
    );

    if (amount > 0n) {
      if (!wallet) throw new Error("player has lossback owed but no wallet");
      await credit(conn, {
        userId,
        amount,
        type: "vip_reward",
        refType: "lossback",
        refId: dateKey,
        idempotencyKey: `lossback:${userId}:${dateKey}`,
      });
    }

    await conn.query(
      `UPDATE vip_progress
          SET period_wagered = 0, period_won = 0, period_started_at = ?, last_lossback_at = ?
        WHERE user_id = ?`,
      [payoutTime, payoutTime, userId],
    );

    await conn.commit();
    return amount;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Runs the payout once now (to catch up after downtime) and then every minute. Each run is a
 * no-op until the next payout time passes, so checking often costs one small query.
 */
export function startLossbackSchedule(intervalMs = 60_000): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const run = await payDailyLossback();
      if (run.playersChecked > 0) console.log("[lossback]", JSON.stringify(run));
    } catch (err) {
      console.error("[lossback] run failed:", err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
