/**
 * The free chip grants: a one-off signup bonus and a daily bonus on a 24-hour cooldown.
 *
 * These are the only ways chips enter the system besides winnings and VIP rewards, and
 * they are why Luck-Cays never needs a payment path. Amounts come from the config table
 * so an admin can change them without a deploy.
 */
import type { BonusStatus, BonusType } from "@luck-cays/shared";
import { conflict } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { CONFIG_KEYS, getChips, getInt } from "../config/config.service.js";
import { dailyMultiplier } from "../vip/vip.service.js";
import { credit, type MovementResult } from "./wallet.service.js";

async function lastClaim(userId: string, bonusType: BonusType): Promise<Date | null> {
  const row = await prisma.bonusClaim.findFirst({
    where: { userId, bonusType },
    orderBy: { claimedAt: "desc" },
    select: { claimedAt: true },
  });
  return row?.claimedAt ?? null;
}

/** Apply the VIP multiplier without touching a float: 2500 at 1.25x is 3125. */
function applyMultiplier(base: bigint, multiplier: number): bigint {
  const scaled = BigInt(Math.round(multiplier * 100));
  return (base * scaled) / 100n;
}

export interface BonusResult extends MovementResult {
  amount: bigint;
  bonusType: BonusType;
}

/**
 * Grant the signup bonus. Idempotent on the user, so a retried signup - or a second
 * call for any reason - cannot hand out two.
 */
export async function grantSignupBonus(userId: string): Promise<BonusResult> {
  const amount = await getChips(CONFIG_KEYS.signupBonusChips);

  const result = await credit({
    userId,
    amount,
    type: "bonus",
    refType: "bonus_signup",
    refId: userId,
    idempotencyKey: `bonus-signup-${userId}`,
  });

  if (!result.replayed) {
    await prisma.bonusClaim.create({ data: { userId, bonusType: "signup", amount } });
  }

  return { ...result, amount, bonusType: "signup" };
}

function cooldownWindow(cooldownHours: number, at: Date): Date {
  return new Date(at.getTime() + cooldownHours * 3_600_000);
}

/**
 * Claim the daily bonus.
 *
 * The amount is the configured base times the player's VIP tier multiplier. The
 * idempotency key is bucketed by the cooldown window rather than being the client's
 * key alone, so two tabs racing the button cannot both be granted.
 */
export async function claimDailyBonus(userId: string): Promise<BonusResult> {
  const cooldownHours = await getInt(CONFIG_KEYS.dailyBonusCooldownHours);
  const previous = await lastClaim(userId, "daily");

  if (previous && cooldownWindow(cooldownHours, previous).getTime() > Date.now()) {
    throw conflict("BONUS_ON_COOLDOWN", "The daily bonus is not available yet", {
      nextAvailableAt: cooldownWindow(cooldownHours, previous).toISOString(),
    });
  }

  const base = await getChips(CONFIG_KEYS.dailyBonusChips);
  const multiplier = await dailyMultiplier(userId);
  const amount = applyMultiplier(base, multiplier);

  // Bucket the key by cooldown period: within one window every attempt collapses onto
  // the same key, so concurrent clicks credit once.
  const bucket = Math.floor(Date.now() / (cooldownHours * 3_600_000));

  const result = await credit({
    userId,
    amount,
    type: "bonus",
    refType: "bonus_daily",
    refId: String(bucket),
    idempotencyKey: `bonus-daily-${userId}-${bucket}`,
  });

  if (result.replayed) {
    throw conflict("BONUS_ON_COOLDOWN", "The daily bonus is not available yet", {
      nextAvailableAt: cooldownWindow(cooldownHours, previous ?? new Date()).toISOString(),
    });
  }

  await prisma.bonusClaim.create({ data: { userId, bonusType: "daily", amount } });

  return { ...result, amount, bonusType: "daily" };
}

export async function getBonusStatus(userId: string): Promise<BonusStatus> {
  const [cooldownHours, base, multiplier, previous, signup] = await Promise.all([
    getInt(CONFIG_KEYS.dailyBonusCooldownHours),
    getChips(CONFIG_KEYS.dailyBonusChips),
    dailyMultiplier(userId),
    lastClaim(userId, "daily"),
    lastClaim(userId, "signup"),
  ]);

  const nextAvailableAt = previous ? cooldownWindow(cooldownHours, previous) : null;
  const available = nextAvailableAt === null || nextAvailableAt.getTime() <= Date.now();

  return {
    daily: {
      available,
      baseAmount: base.toString(10),
      amount: applyMultiplier(base, multiplier).toString(10),
      multiplier,
      nextAvailableAt: available ? null : (nextAvailableAt?.toISOString() ?? null),
    },
    signupClaimed: signup !== null,
  };
}
