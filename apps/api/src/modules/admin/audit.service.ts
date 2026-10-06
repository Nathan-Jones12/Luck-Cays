/**
 * The audit log. Every admin action and every security-relevant event lands here.
 *
 * Append-only, like the ledger. Writes must never break the thing they are recording:
 * if an audit insert fails we log loudly and carry on, because failing a login because
 * its audit row could not be written would be worse than a gap in the log.
 */
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

export const AUDIT_ACTIONS = {
  signup: "auth.signup",
  login: "auth.login",
  loginFailed: "auth.login_failed",
  loginLocked: "auth.login_locked",
  logout: "auth.logout",
  refreshReuse: "auth.refresh_reuse",
  passwordResetRequested: "auth.password_reset_requested",
  passwordReset: "auth.password_reset",
  emailVerified: "auth.email_verified",
  totpEnabled: "auth.totp_enabled",
  totpDisabled: "auth.totp_disabled",
  backupCodesRegenerated: "auth.backup_codes_regenerated",

  adminChipAdjustment: "admin.chip_adjustment",
  adminStatusChange: "admin.status_change",
  adminRoleChange: "admin.role_change",
  adminGameConfig: "admin.game_config",
  adminGrantFreeSpins: "admin.grant_free_spins",
  adminSettleBet: "admin.settle_bet",
  adminSetEventResult: "admin.set_event_result",
  adminConfigChange: "admin.config_change",
} as const;

export interface AuditInput {
  /** Null for unauthenticated events such as a failed login. */
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Serialised to JSON. Must not contain secrets - the logger's redaction does not reach here. */
  details?: Record<string, unknown>;
  ip?: string;
}

export async function record(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        detailsJson: input.details ? JSON.stringify(input.details) : null,
        ip: input.ip ?? null,
      },
    });
  } catch (error) {
    logger.error({ err: error, action: input.action }, "failed to write audit log entry");
  }
}

export interface AuditPage {
  entries: Array<{
    id: string;
    actorId: string | null;
    actorUsername: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    details: unknown;
    ip: string | null;
    createdAt: Date;
  }>;
  nextCursor: string | null;
}

export async function list(options: {
  limit: number;
  cursor?: string;
  action?: string;
  actorId?: string;
}): Promise<AuditPage> {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(options.action ? { action: options.action } : {}),
      ...(options.actorId ? { actorId: options.actorId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      actorId: true,
      action: true,
      targetType: true,
      targetId: true,
      detailsJson: true,
      ip: true,
      createdAt: true,
      actor: { select: { username: true } },
    },
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    entries: page.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorUsername: row.actor?.username ?? null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      details: row.detailsJson ? safeParse(row.detailsJson) : null,
      ip: row.ip,
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** A malformed details blob must not break the whole audit page. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { unparseable: true };
  }
}
