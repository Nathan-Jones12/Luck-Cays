import { z } from "zod";
import { chipStringSchema } from "./common.js";

export const vipTierSchema = z.object({
  id: z.number().int(),
  name: z.enum(["Bronze", "Silver", "Gold", "Platinum", "Diamond"]),
  minPoints: z.number().int().nonnegative(),
  /** Daily bonus multiplier, e.g. 1.5 at Gold. */
  dailyMultiplier: z.number().min(1),
  levelupBonus: chipStringSchema,
  /** Weekly cashback on net losses, as a whole percentage. */
  cashbackPct: z.number().int().min(0).max(100),
});
export type VipTier = z.infer<typeof vipTierSchema>;

export const vipProgressSchema = z.object({
  lifetimePoints: z.number().int().nonnegative(),
  tier: vipTierSchema,
  nextTier: vipTierSchema.nullable(),
  /** Points still needed for the next tier; 0 at Diamond. */
  pointsToNextTier: z.number().int().nonnegative(),
  /** 0-1 progress through the current tier, for the progress bar. */
  tierProgress: z.number().min(0).max(1),
  /** Net chip losses this week, the base for cashback. */
  weekNetLoss: chipStringSchema,
  /** Cashback that would be paid on the current week's losses. */
  pendingCashback: chipStringSchema,
});
export type VipProgress = z.infer<typeof vipProgressSchema>;
