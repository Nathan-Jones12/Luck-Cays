import { z } from "zod";
import {
  paginationSchema,
  roleSchema,
  signedChipStringSchema,
  userStatusSchema,
} from "./common.js";

export const playerSearchSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: userStatusSchema.optional(),
});

/**
 * A manual chip adjustment. The reason is mandatory and lands in the audit log -
 * an unexplained balance change is exactly what the ledger exists to prevent.
 */
export const adjustChipsSchema = z.object({
  userId: z.string().min(1),
  /** Signed: negative takes chips away. Never allowed to push a balance below 0. */
  amount: signedChipStringSchema.refine((v) => v !== "0", "adjustment cannot be zero"),
  reason: z.string().trim().min(5).max(500),
});

export const setUserStatusSchema = z.object({
  userId: z.string().min(1),
  status: userStatusSchema,
  reason: z.string().trim().min(5).max(500),
});

export const setUserRoleSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
  reason: z.string().trim().min(5).max(500),
});

export const updateSlotGameSchema = z.object({
  slug: z.string().min(1).max(60),
  isActive: z.boolean().optional(),
  /** Full replacement config; validated against slotConfigSchema server-side. */
  config: z.unknown().optional(),
});

export const settleBetSchema = z.object({
  betId: z.string().min(1),
  outcome: z.enum(["won", "lost", "push", "void"]),
  reason: z.string().trim().min(5).max(500),
});

export const setEventResultSchema = z.object({
  eventId: z.string().min(1),
  homeScore: z.number().int().min(0).max(999),
  awayScore: z.number().int().min(0).max(999),
  reason: z.string().trim().min(5).max(500),
});

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().max(60).optional(),
  actorId: z.string().max(64).optional(),
});
