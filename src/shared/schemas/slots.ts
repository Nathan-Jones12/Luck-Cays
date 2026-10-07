import { z } from "zod";
import { chipStringSchema, idempotencyKeySchema, paginationSchema } from "./common.js";

export const slotGameSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  theme: z.string(),
  rtpTarget: z.number(),
  betLevels: z.array(z.number().int().positive()),
  isActive: z.boolean(),
});
export type SlotGameSummary = z.infer<typeof slotGameSummarySchema>;

/**
 * A spin request. `bet` must be one of the game's `betLevels`; the server
 * re-checks rather than trusting it. During a free-spin run the bet is taken
 * from the stored session and this field is ignored.
 */
export const spinSchema = z.object({
  gameSlug: z.string().min(1).max(60),
  bet: chipStringSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type SpinInput = z.infer<typeof spinSchema>;

export const spinHistoryQuerySchema = paginationSchema.extend({
  gameSlug: z.string().max(60).optional(),
});

/**
 * Autoplay is a client-side loop over the normal spin endpoint - the server has
 * no autoplay mode, so a stop condition can never be used to influence outcomes.
 * These are the conditions the client enforces locally.
 */
export const autoplaySettingsSchema = z.object({
  spins: z.number().int().min(1).max(1000),
  stopOnAnyWin: z.boolean().default(false),
  stopOnFreeSpins: z.boolean().default(true),
  /** Stop if a single win is at least this many chips. Empty string = off. */
  stopIfSingleWinAtLeast: chipStringSchema.or(z.literal("")).default(""),
  /** Stop if cumulative loss reaches this many chips. Empty string = off. */
  stopIfLossReaches: chipStringSchema.or(z.literal("")).default(""),
});
export type AutoplaySettings = z.infer<typeof autoplaySettingsSchema>;
