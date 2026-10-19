/**
 * Tests the daily lossback, against the real database.
 *
 *  1. The payout-time maths, including a daylight-saving change.
 *  2. End to end: a temporary player bets, the job pays them the right amount through the
 *     ledger, and a second run pays nothing more.
 *
 * The temporary player (id "test-lossback-...") and everything attached to it are deleted
 * at the end, pass or fail. Usage: npm run test:lossback
 */
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../src/db.js";
import { payDailyLossback } from "../src/jobs/lossback.js";
import { lastDailyTime, localDateKey, nextDailyTime } from "../src/time.js";
import { credit } from "../src/wallet.js";
import { getProgress, recordBet } from "../src/vip.js";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`);
}

// --- 1. Payout-time maths (Nassau: UTC-4 in summer, UTC-5 in winter) -------------------
const tz = "America/Nassau";
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

check("1:59pm EDT -> last payout was yesterday 2pm",
  iso(lastDailyTime(at("2026-10-19T17:59:00Z"), "14:00", tz)), "2026-10-18T18:00:00.000Z");
check("1:59pm EDT -> next payout is today 2pm",
  iso(nextDailyTime(at("2026-10-19T17:59:00Z"), "14:00", tz)), "2026-10-19T18:00:00.000Z");
check("exactly 2pm EDT counts as today's payout",
  iso(lastDailyTime(at("2026-10-19T18:00:00Z"), "14:00", tz)), "2026-10-19T18:00:00.000Z");
check("winter: 2pm EST is 19:00 UTC",
  iso(lastDailyTime(at("2026-12-01T20:00:00Z"), "14:00", tz)), "2026-12-01T19:00:00.000Z");
check("DST ends 1 Nov: 1:30pm EST -> last payout 31 Oct 2pm EDT",
  iso(lastDailyTime(at("2026-11-01T18:30:00Z"), "14:00", tz)), "2026-10-31T18:00:00.000Z");
check("DST ends 1 Nov: next payout 1 Nov 2pm EST",
  iso(nextDailyTime(at("2026-11-01T18:30:00Z"), "14:00", tz)), "2026-11-01T19:00:00.000Z");
check("date key uses Nassau's date, not UTC's",
  localDateKey(at("2026-11-01T03:00:00Z"), tz), "2026-10-31");

// --- 2. End to end against the database -------------------------------------------------
const userId = `test-lossback-${randomUUID()}`;
const walletId = randomUUID();

async function walletBalance(): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT balance FROM wallets WHERE id = ?", [walletId]);
  return String(rows[0]?.balance);
}

try {
  await pool.query(
    "INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, 'not-a-real-hash')",
    [userId, `${userId}@example.invalid`, userId],
  );
  await pool.query("INSERT INTO wallets (id, user_id, balance) VALUES (?, ?, 1000)", [walletId, userId]);

  // A losing slots session (staked 10,000, won back 4,000) and a poker hand (excluded).
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await recordBet(conn, { userId, game: "slots", wagered: 10_000n, won: 4_000n });
    await recordBet(conn, { userId, game: "poker", wagered: 5_000n, won: 0n });
    await conn.commit();
  } finally {
    conn.release();
  }

  // Grunt is 1.5%: (10,000 - 4,000) x 1.5% = 90. Poker counts for points but not lossback.
  const before = await getProgress(userId);
  check("points: 15,000 LC wagered / 100", before?.lifetimePoints, 150);
  check("tier", before?.tier.name, "Grunt");
  check("period wagered excludes poker", before?.periodWagered, "10000");
  check("pending lossback", before?.pendingLossback, "90");

  // Not due yet: the period started after the most recent 2pm.
  check("nothing paid before the period has closed", (await payDailyLossback()).playersPaid, 0);

  // Pretend the period started two days ago, so the latest 2pm has closed it.
  await pool.query(
    "UPDATE vip_progress SET period_started_at = NOW(3) - INTERVAL 2 DAY WHERE user_id = ?",
    [userId],
  );
  const run = await payDailyLossback();
  check("job pays the player", run.playersPaid >= 1, true);
  check("wallet credited 90", await walletBalance(), "1090");

  const [ledger] = await pool.query<RowDataPacket[]>(
    "SELECT amount, type, ref_type, balance_after FROM ledger_entries WHERE wallet_id = ?",
    [walletId],
  );
  check("one ledger entry, balance_after matches", ledger.map((r) => ({ ...r })), [
    { amount: "90", type: "vip_reward", ref_type: "lossback", balance_after: "1090" },
  ]);

  const after = await getProgress(userId);
  check("period reset after payout", [after?.periodWagered, after?.periodWon, after?.pendingLossback], ["0", "0", "0"]);
  check("lifetime points kept", after?.lifetimePoints, 150);

  await payDailyLossback();
  check("second run pays nothing more", await walletBalance(), "1090");

  // The idempotency key alone also blocks a double credit.
  const replayConn = await pool.getConnection();
  try {
    await replayConn.beginTransaction();
    const [[last]] = await replayConn.query<RowDataPacket[]>(
      "SELECT idempotency_key FROM ledger_entries WHERE wallet_id = ?",
      [walletId],
    );
    const replay = await credit(replayConn, {
      userId, amount: 90n, type: "vip_reward", idempotencyKey: String(last?.idempotency_key),
    });
    await replayConn.commit();
    check("replaying the idempotency key moves nothing", replay, null);
  } finally {
    replayConn.release();
  }
  check("balance still 1090", await walletBalance(), "1090");
} finally {
  // Test fixture only: deleting the user cascades to its wallet, ledger and VIP rows.
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.end();
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exitCode = failed === 0 ? 0 : 1;
