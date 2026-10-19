import { z } from "zod";
import { chipStringSchema } from "./common.js";

export const vipTierSchema = z.object({
  id: z.number().int(),
  /** Tier names live in the database (Grunt ... Shark), so any name is accepted. */
  name: z.string().min(1),
  minPoints: z.number().int().nonnegative(),
  /** Daily bonus multiplier, e.g. 1.5. 1 means no boost. */
  dailyMultiplier: z.number().min(1),
  levelupBonus: chipStringSchema,
  /** Daily lossback rate in basis points: 150 = 1.5%. */
  lossbackBp: z.number().int().min(0).max(10_000),
});
export type VipTier = z.infer<typeof vipTierSchema>;

export const vipProgressSchema = z.object({
  lifetimePoints: z.number().int().nonnegative(),
  tier: vipTierSchema,
  nextTier: vipTierSchema.nullable(),
  /** Points still needed for the next tier; 0 at the top tier. */
  pointsToNextTier: z.number().int().nonnegative(),
  /** 0-1 progress through the current tier, for the progress bar. */
  tierProgress: z.number().min(0).max(1),
  /** Chips staked on lossback games since the last daily payout. */
  periodWagered: chipStringSchema,
  /** Chips won back on lossback games since the last daily payout. */
  periodWon: chipStringSchema,
  /** periodWagered - periodWon, or 0 if the player is up. The base for lossback. */
  periodNetLoss: chipStringSchema,
  /** Lossback the next payout would pay on the current period. */
  pendingLossback: chipStringSchema,
  /** When the next daily payout happens, ISO 8601. */
  nextPayoutAt: z.string().datetime(),
});
export type VipProgress = z.infer<typeof vipProgressSchema>;
