import { z } from "zod";
import { chipStringSchema, idempotencyKeySchema, paginationSchema } from "./common.js";

export const marketTypeSchema = z.enum(["moneyline", "spread", "totals"]);
export type MarketType = z.infer<typeof marketTypeSchema>;

export const eventStatusSchema = z.enum(["scheduled", "live", "final", "cancelled"]);
export const marketStatusSchema = z.enum(["open", "suspended", "settled", "void"]);
export const betStatusSchema = z.enum(["open", "won", "lost", "push", "void"]);
export type BetStatus = z.infer<typeof betStatusSchema>;

/**
 * Decimal odds, two places, as a string so no float rounding reaches the money
 * path. 2.50 means a 100-chip stake returns 250 chips total.
 */
export const oddsSchema = z
  .string()
  .regex(/^\d+\.\d{2}$/, "odds are decimal with exactly 2 places, e.g. 2.50")
  .refine((v) => Number(v) >= 1.01, "odds must be at least 1.01");

export const selectionSchema = z.object({
  /** Stable key within the market: "home" | "away" | "draw" | "over" | "under". */
  key: z.string().min(1).max(20),
  label: z.string().min(1).max(60),
  odds: oddsSchema,
});
export type Selection = z.infer<typeof selectionSchema>;

export const sportsMarketSchema = z.object({
  id: z.string(),
  type: marketTypeSchema,
  /** Handicap or total line, e.g. "-3.5" or "47.5". Null for moneyline. */
  line: z.string().nullable(),
  status: marketStatusSchema,
  selections: z.array(selectionSchema).min(2),
});
export type SportsMarket = z.infer<typeof sportsMarketSchema>;

export const sportsEventSchema = z.object({
  id: z.string(),
  sport: z.string(),
  league: z.string(),
  home: z.string(),
  away: z.string(),
  startsAt: z.string(),
  status: eventStatusSchema,
  result: z.object({ homeScore: z.number().int(), awayScore: z.number().int() }).nullable(),
  markets: z.array(sportsMarketSchema),
});
export type SportsEvent = z.infer<typeof sportsEventSchema>;

export const eventsQuerySchema = paginationSchema.extend({
  sport: z.string().max(40).optional(),
  league: z.string().max(60).optional(),
});

/**
 * Place a bet. `odds` is what the player saw. If the stored odds have moved the
 * API rejects with `ODDS_CHANGED` and returns the current odds, so the client
 * can ask the player to confirm rather than silently repricing the bet.
 */
export const placeBetSchema = z.object({
  marketId: z.string().min(1),
  selection: z.string().min(1).max(20),
  odds: oddsSchema,
  stake: chipStringSchema,
  idempotencyKey: idempotencyKeySchema,
  /** Set true to accept the current odds after an ODDS_CHANGED rejection. */
  acceptOddsChange: z.boolean().default(false),
});
export type PlaceBetInput = z.infer<typeof placeBetSchema>;

export const sportsBetSchema = z.object({
  id: z.string(),
  event: z.object({
    home: z.string(),
    away: z.string(),
    sport: z.string(),
    league: z.string(),
    startsAt: z.string(),
    status: eventStatusSchema,
    result: z.object({ homeScore: z.number().int(), awayScore: z.number().int() }).nullable(),
  }),
  market: z.object({ type: marketTypeSchema, line: z.string().nullable() }),
  selection: z.string(),
  selectionLabel: z.string(),
  odds: oddsSchema,
  stake: chipStringSchema,
  potentialWin: chipStringSchema,
  status: betStatusSchema,
  settledAt: z.string().nullable(),
  placedAt: z.string(),
});
export type SportsBet = z.infer<typeof sportsBetSchema>;

export const betsQuerySchema = paginationSchema.extend({
  status: betStatusSchema.optional(),
});
