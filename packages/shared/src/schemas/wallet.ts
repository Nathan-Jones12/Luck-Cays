import { z } from "zod";
import {
  bonusTypeSchema,
  chipStringSchema,
  idempotencyKeySchema,
  ledgerTypeSchema,
  paginationSchema,
  signedChipStringSchema,
} from "./common.js";

/** The wallet is the only writer of balances; this is its public contract. */

export const walletSchema = z.object({
  balance: chipStringSchema,
  currency: z.literal("LC"),
});
export type Wallet = z.infer<typeof walletSchema>;

export const ledgerEntrySchema = z.object({
  id: z.string(),
  /** Positive credits, negative debits. */
  amount: signedChipStringSchema,
  type: ledgerTypeSchema,
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  balanceAfter: chipStringSchema,
  createdAt: z.string(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const ledgerQuerySchema = paginationSchema.extend({
  type: ledgerTypeSchema.optional(),
});

export const claimBonusSchema = z.object({
  bonusType: bonusTypeSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const bonusStatusSchema = z.object({
  daily: z.object({
    available: z.boolean(),
    /** Base amount before the VIP tier multiplier. */
    baseAmount: chipStringSchema,
    /** What this player would actually receive right now. */
    amount: chipStringSchema,
    multiplier: z.number(),
    nextAvailableAt: z.string().nullable(),
  }),
  signupClaimed: z.boolean(),
});
export type BonusStatus = z.infer<typeof bonusStatusSchema>;
