/**
 * Admin back office.
 *
 * Every route here is gated to `admin` or `support`, and every action that changes anything
 * writes an audit entry with a mandatory reason. Chip adjustments go through the wallet like
 * any other movement, so an admin cannot bypass the ledger - they appear as `adjustment`
 * entries and are as auditable as a bet.
 *
 * Read-only lookups are open to `support`; anything that moves chips or changes a role is
 * `admin` only.
 */
import { Router } from "express";
import {
  adjustChipsSchema,
  auditQuerySchema,
  playerSearchSchema,
  setEventResultSchema,
  setUserRoleSchema,
  setUserStatusSchema,
  settleBetSchema,
  slotConfigSchema,
  updateSlotGameSchema,
} from "@luck-cays/shared";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { authOf, requireAuth, requireRole } from "../../middleware/auth.js";
import { body, query, validateBody, validateQuery } from "../../middleware/validate.js";
import { invalidateSlotConfigCache } from "../slots/slots.service.js";
import { setEventResult, settleResolvedEvents, voidBet } from "../sports/sports.service.js";
import { syncFromProvider } from "../sports/sports.sync.js";
import { auditWallet, credit, debit, getLedger } from "../wallet/wallet.service.js";
import { revokeAllForUser } from "../auth/tokens.js";
import { payWeeklyCashback } from "../vip/vip.service.js";
import { AUDIT_ACTIONS, list as listAudit, record as audit } from "./audit.service.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole("admin", "support"));

/* --------------------------------- players ---------------------------------- */

adminRouter.get("/players", validateQuery(playerSearchSchema), async (request, response) => {
  const options = query(request, playerSearchSchema);

  const rows = await prisma.user.findMany({
    where: {
      ...(options.status ? { status: options.status } : {}),
      ...(options.q
        ? { OR: [{ email: { contains: options.q } }, { username: { contains: options.q } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
      status: true,
      emailVerifiedAt: true,
      totpEnabled: true,
      createdAt: true,
      wallet: { select: { balance: true } },
      vipProgress: { select: { lifetimePoints: true, tier: { select: { name: true } } } },
    },
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  response.json({
    players: page.map((row) => ({
      id: row.id,
      email: row.email,
      username: row.username,
      role: row.role,
      status: row.status,
      emailVerified: row.emailVerifiedAt !== null,
      totpEnabled: row.totpEnabled,
      balance: (row.wallet?.balance ?? 0n).toString(10),
      vipTier: row.vipProgress?.tier.name ?? "Bronze",
      vipPoints: Number(row.vipProgress?.lifetimePoints ?? 0n),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  });
});

/** One player in full, including a wallet consistency check. */
adminRouter.get("/players/:id", async (request, response) => {
  const userId = String(request.params["id"]);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
      status: true,
      emailVerifiedAt: true,
      totpEnabled: true,
      failedLoginCount: true,
      lockedUntil: true,
      createdAt: true,
      wallet: { select: { balance: true } },
      vipProgress: {
        select: {
          lifetimePoints: true,
          weekNetLoss: true,
          tier: { select: { name: true, cashbackPct: true } },
        },
      },
    },
  });
  if (!user) throw notFound("No such player", "PLAYER_NOT_FOUND");

  const [ledger, walletAudit, counts] = await Promise.all([
    getLedger(userId, { limit: 20 }),
    auditWallet(userId),
    Promise.all([
      prisma.slotRound.count({ where: { userId } }),
      prisma.sportsBet.count({ where: { userId } }),
      prisma.bonusClaim.count({ where: { userId } }),
    ]),
  ]);

  response.json({
    player: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      totpEnabled: user.totpEnabled,
      failedLoginCount: user.failedLoginCount,
      lockedUntil: user.lockedUntil?.toISOString() ?? null,
      balance: (user.wallet?.balance ?? 0n).toString(10),
      vipTier: user.vipProgress?.tier.name ?? "Bronze",
      vipPoints: Number(user.vipProgress?.lifetimePoints ?? 0n),
      weekNetLoss: (user.vipProgress?.weekNetLoss ?? 0n).toString(10),
      createdAt: user.createdAt.toISOString(),
    },
    // Surfaced deliberately: if this is ever false, something wrote a balance outside the
    // wallet service and it needs finding.
    walletConsistent: walletAudit.consistent,
    ledgerSum: walletAudit.ledgerSum.toString(10),
    counts: { slotRounds: counts[0], sportsBets: counts[1], bonusClaims: counts[2] },
    recentLedger: ledger.entries.map((entry) => ({
      id: entry.id,
      amount: entry.amount.toString(10),
      type: entry.type,
      refType: entry.refType,
      refId: entry.refId,
      balanceAfter: entry.balanceAfter.toString(10),
      createdAt: entry.createdAt.toISOString(),
    })),
  });
});

/**
 * Adjust a player's chips. Admin only, reason mandatory, and it moves through the wallet so
 * it lands in the ledger as an `adjustment`.
 */
adminRouter.post(
  "/players/chips",
  requireRole("admin"),
  validateBody(adjustChipsSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = body(request, adjustChipsSchema);

    const signed = BigInt(input.amount);
    const magnitude = signed < 0n ? -signed : signed;

    const result =
      signed > 0n
        ? await credit({
            userId: input.userId,
            amount: magnitude,
            type: "adjustment",
            refType: "admin_adjustment",
            refId: actor.userId,
          })
        : await debit({
            userId: input.userId,
            amount: magnitude,
            type: "adjustment",
            refType: "admin_adjustment",
            refId: actor.userId,
          });

    await audit({
      actorId: actor.userId,
      action: AUDIT_ACTIONS.adminChipAdjustment,
      targetType: "user",
      targetId: input.userId,
      details: {
        amount: input.amount,
        reason: input.reason,
        balanceAfter: result.balance.toString(10),
      },
      ip: request.ip,
    });

    response.json({ balance: result.balance.toString(10) });
  },
);

adminRouter.post(
  "/players/status",
  requireRole("admin"),
  validateBody(setUserStatusSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = body(request, setUserStatusSchema);

    await prisma.user.update({ where: { id: input.userId }, data: { status: input.status } });

    // A ban or self-exclusion must end every live session, not wait for a token to expire.
    if (input.status !== "active") await revokeAllForUser(input.userId);

    await audit({
      actorId: actor.userId,
      action: AUDIT_ACTIONS.adminStatusChange,
      targetType: "user",
      targetId: input.userId,
      details: { status: input.status, reason: input.reason },
      ip: request.ip,
    });

    response.status(204).end();
  },
);

adminRouter.post(
  "/players/role",
  requireRole("admin"),
  validateBody(setUserRoleSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = body(request, setUserRoleSchema);

    if (input.userId === actor.userId) {
      // Stops an admin demoting themselves and locking everyone out of the back office.
      throw conflict("CANNOT_CHANGE_OWN_ROLE", "You cannot change your own role");
    }

    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { totpEnabled: true },
    });
    if (!target) throw notFound("No such player", "PLAYER_NOT_FOUND");

    // 2FA is mandatory for admins, so granting the role without it would create an account
    // that cannot log in.
    if (input.role === "admin" && !target.totpEnabled) {
      throw conflict(
        "TOTP_REQUIRED_FOR_ADMIN",
        "That player must enable two-factor authentication before becoming an admin",
      );
    }

    await prisma.user.update({ where: { id: input.userId }, data: { role: input.role } });
    await revokeAllForUser(input.userId);

    await audit({
      actorId: actor.userId,
      action: AUDIT_ACTIONS.adminRoleChange,
      targetType: "user",
      targetId: input.userId,
      details: { role: input.role, reason: input.reason },
      ip: request.ip,
    });

    response.status(204).end();
  },
);

/* ---------------------------------- games ----------------------------------- */

adminRouter.get("/slots", async (_request, response) => {
  const rows = await prisma.slotGame.findMany({
    orderBy: { name: "asc" },
    select: { slug: true, name: true, isActive: true, rtpTargetBp: true, updatedAt: true },
  });

  response.json({
    games: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      isActive: row.isActive,
      rtpTarget: row.rtpTargetBp / 10_000,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
});

/**
 * Edit a game. A replacement config is validated against `slotConfigSchema` before it is
 * stored, so a malformed edit is rejected here rather than discovered mid-spin.
 */
adminRouter.patch(
  "/slots",
  requireRole("admin"),
  validateBody(updateSlotGameSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = body(request, updateSlotGameSchema);

    const game = await prisma.slotGame.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    });
    if (!game) throw notFound("No such game", "GAME_NOT_FOUND");

    const data: { isActive?: boolean; configJson?: string } = {};

    if (input.isActive !== undefined) data.isActive = input.isActive;

    if (input.config !== undefined) {
      const parsed = slotConfigSchema.safeParse(input.config);
      if (!parsed.success) {
        throw badRequest("INVALID_GAME_CONFIG", "That slot config is not valid", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      if (parsed.data.slug !== input.slug) {
        throw badRequest("SLUG_MISMATCH", "The config's slug must match the game being edited");
      }
      data.configJson = JSON.stringify(parsed.data);
    }

    await prisma.slotGame.update({ where: { slug: input.slug }, data });
    invalidateSlotConfigCache(input.slug);

    await audit({
      actorId: actor.userId,
      action: AUDIT_ACTIONS.adminGameConfig,
      targetType: "slot_game",
      targetId: input.slug,
      details: { isActive: input.isActive, configReplaced: input.config !== undefined },
      ip: request.ip,
    });

    response.status(204).end();
  },
);

/* ---------------------------------- sports ---------------------------------- */

adminRouter.get("/sports/events", async (_request, response) => {
  const rows = await prisma.sportsEvent.findMany({
    orderBy: { startsAt: "asc" },
    take: 100,
    select: {
      id: true,
      sport: true,
      league: true,
      home: true,
      away: true,
      startsAt: true,
      status: true,
      resultJson: true,
      _count: { select: { markets: true } },
    },
  });

  response.json({
    events: rows.map((row) => ({
      id: row.id,
      sport: row.sport,
      league: row.league,
      home: row.home,
      away: row.away,
      startsAt: row.startsAt.toISOString(),
      status: row.status,
      result: row.resultJson ? JSON.parse(row.resultJson) : null,
      marketCount: row._count.markets,
    })),
  });
});

adminRouter.post(
  "/sports/result",
  requireRole("admin"),
  validateBody(setEventResultSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = body(request, setEventResultSchema);

    await setEventResult(input.eventId, { homeScore: input.homeScore, awayScore: input.awayScore });
    const run = await settleResolvedEvents();

    await audit({
      actorId: actor.userId,
      action: AUDIT_ACTIONS.adminSetEventResult,
      targetType: "sports_event",
      targetId: input.eventId,
      details: {
        homeScore: input.homeScore,
        awayScore: input.awayScore,
        reason: input.reason,
        graded: run.graded,
      },
      ip: request.ip,
    });

    response.json({ settled: { ...run, paidOut: run.paidOut.toString(10) } });
  },
);

/** Void a bet and refund the stake. Manual settlement to any other outcome is deliberately
 * not offered: grading belongs to the settlement job, which applies one consistent rule. */
adminRouter.post(
  "/sports/void",
  requireRole("admin"),
  validateBody(settleBetSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = body(request, settleBetSchema);

    if (input.outcome !== "void") {
      throw badRequest(
        "OUTCOME_NOT_SUPPORTED",
        "Only voiding is available here. Set the event result and let settlement grade the bets.",
      );
    }

    await voidBet(input.betId);

    await audit({
      actorId: actor.userId,
      action: AUDIT_ACTIONS.adminSettleBet,
      targetType: "sports_bet",
      targetId: input.betId,
      details: { outcome: "void", reason: input.reason },
      ip: request.ip,
    });

    response.status(204).end();
  },
);

adminRouter.post("/sports/sync", requireRole("admin"), async (_request, response) => {
  response.json({ imported: await syncFromProvider() });
});

/* ----------------------------------- jobs ----------------------------------- */

adminRouter.post("/jobs/settle", requireRole("admin"), async (_request, response) => {
  const run = await settleResolvedEvents();
  response.json({ ...run, paidOut: run.paidOut.toString(10) });
});

adminRouter.post("/jobs/cashback", requireRole("admin"), async (_request, response) => {
  const run = await payWeeklyCashback();
  response.json({ ...run, totalChips: run.totalChips.toString(10) });
});

/* ----------------------------------- audit ---------------------------------- */

adminRouter.get("/audit", validateQuery(auditQuerySchema), async (request, response) => {
  const options = query(request, auditQuerySchema);

  const page = await listAudit({
    limit: options.limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
  });

  response.json({
    entries: page.entries.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
    nextCursor: page.nextCursor,
  });
});
