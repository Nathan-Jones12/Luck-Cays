/**
 * Tunable values that the PRD wants out of code and into a table, so an admin can
 * change a bonus without a deploy.
 *
 * Reads are cached briefly. These are read on nearly every bonus claim and change
 * rarely, and a few seconds of staleness after an admin edit is a fair trade for not
 * querying the same row on every request.
 */
import { prisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";

export const CONFIG_KEYS = {
  signupBonusChips: "bonus.signup.chips",
  dailyBonusChips: "bonus.daily.chips",
  dailyBonusCooldownHours: "bonus.daily.cooldown_hours",
  vipPointsPerChips: "vip.points_per_chips",
  cashbackWeekDays: "vip.cashback_week_days",
} as const;

/** Defaults, used when a key is missing from the table. */
const DEFAULTS: Record<string, string> = {
  [CONFIG_KEYS.signupBonusChips]: String(env.SIGNUP_BONUS_CHIPS),
  [CONFIG_KEYS.dailyBonusChips]: String(env.DAILY_BONUS_CHIPS),
  [CONFIG_KEYS.dailyBonusCooldownHours]: "24",
  // 1 VIP point per 100 chips wagered, per the PRD's example.
  [CONFIG_KEYS.vipPointsPerChips]: "100",
  [CONFIG_KEYS.cashbackWeekDays]: "7",
};

const CACHE_TTL_MS = 5_000;

let cache: Map<string, string> | null = null;
let cachedAt = 0;

async function load(): Promise<Map<string, string>> {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

  const rows = await prisma.configValue.findMany({ select: { key: true, value: true } });
  cache = new Map(rows.map((row) => [row.key, row.value]));
  cachedAt = Date.now();
  return cache;
}

/** Drop the cache so the next read sees a just-written value. */
export function invalidateConfigCache(): void {
  cache = null;
}

export async function getString(key: string): Promise<string> {
  const values = await load();
  const value = values.get(key) ?? DEFAULTS[key];
  if (value === undefined) throw new Error(`no config value or default for "${key}"`);
  return value;
}

/** A whole-chip config value. Throws rather than silently yielding NaN. */
export async function getChips(key: string): Promise<bigint> {
  const raw = await getString(key);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`config "${key}" must be a non-negative integer, got "${raw}"`);
  }
  return BigInt(raw);
}

export async function getInt(key: string): Promise<number> {
  const raw = await getString(key);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`config "${key}" must be an integer, got "${raw}"`);
  }
  return parsed;
}

export async function setValue(key: string, value: string, description?: string): Promise<void> {
  await prisma.configValue.upsert({
    where: { key },
    create: { key, value, description: description ?? null },
    update: { value, ...(description === undefined ? {} : { description }) },
  });
  invalidateConfigCache();
  logger.info({ key }, "config value updated");
}

/** Write the defaults into the table, for the seed. Existing values are left alone. */
export async function seedDefaults(): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await prisma.configValue.upsert({ where: { key }, create: { key, value }, update: {} });
  }
  invalidateConfigCache();
}
