import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db.js";

/**
 * Runtime settings from the `config_values` table, so rules like the lossback time can
 * change without a deploy. Read fresh each time - these are read rarely.
 */
export async function getConfig(key: string, fallback: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT `value` FROM config_values WHERE `key` = ?",
    [key],
  );
  return (rows[0]?.value as string | undefined) ?? fallback;
}

export interface LossbackSettings {
  /** Daily payout time, HH:MM on a 24h clock, in `timeZone`. */
  time: string;
  /** IANA timezone, e.g. America/Nassau. */
  timeZone: string;
  /** Games whose bets count toward lossback. */
  games: string[];
}

export async function getLossbackSettings(): Promise<LossbackSettings> {
  const [time, timeZone, games] = await Promise.all([
    getConfig("vip.lossback_time", "14:00"),
    getConfig("vip.lossback_timezone", "America/Nassau"),
    getConfig("vip.lossback_games", "slots,sports"),
  ]);
  return {
    time,
    timeZone,
    games: games
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  };
}
