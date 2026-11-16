import { z } from "zod";

/** A chip amount on the wire: a decimal integer string, never a JSON number. */
export const chipStringSchema = z
  .string()
  .regex(/^\d+$/, "chip amounts are non-negative decimal integer strings");

/** A signed chip amount (ledger entries and admin adjustments can be negative). */
export const signedChipStringSchema = z
  .string()
  .regex(/^-?\d+$/, "chip amounts are decimal integer strings");

export const cuidSchema = z.string().min(8).max(64);

/**
 * Idempotency key for anything that moves chips. The client generates one per
 * logical bet and reuses it on retry, so a dropped response can never double-spend.
 */
export const idempotencyKeySchema = z
  .string()
  .min(16, "idempotency key must be at least 16 chars")
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "idempotency key must be url-safe");

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const roleSchema = z.enum(["player", "support", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const userStatusSchema = z.enum(["active", "banned", "self_excluded"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const ledgerTypeSchema = z.enum([
  "bet",
  "win",
  "bonus",
  "vip_reward",
  "refund",
  "adjustment",
  "poker_buyin",
  "poker_cashout",
]);
export type LedgerType = z.infer<typeof ledgerTypeSchema>;

export const bonusTypeSchema = z.enum(["signup", "daily", "levelup", "cashback"]);
export type BonusType = z.infer<typeof bonusTypeSchema>;

/** Shape every error response takes, so the client can branch on `code`. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
