/**
 * The spin service.
 *
 * The flow the PRD specifies: client sends a bet, the server debits, picks the stops,
 * grades the wins, credits, saves the round, and hands back the stops for the client to
 * animate to. The client is told the answer; it never computes one.
 *
 * Three things make this safe:
 *
 *  - ATOMICITY. Debit, round, credit and free-spin bookkeeping all happen in one wallet
 *    transaction. There is no instant where chips are gone and no round exists.
 *  - IDEMPOTENCY. The round carries the client's key. A retried spin returns the
 *    original round instead of spinning again, so a dropped response cannot cost a bet
 *    or hand out a second win.
 *  - SERVER-SIDE FREE SPINS. Remaining free spins and the bet they are locked to live in
 *    the database. A client cannot grant itself spins or replay them at a higher stake.
 */
import {
  buildGrid,
  evaluate,
  pickStops,
  slotConfigSchema,
  type SlotConfig,
  type SlotSpinResult,
  type SlotGameSummary,
} from "@luck-cays/shared";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { secureRandomInt } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma, type Tx } from "../../lib/prisma.js";
import { recordWager } from "../vip/vip.service.js";
import { transact } from "../wallet/wallet.service.js";

/* -------------------------------------------------------------------------- */
/* Game configs                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Configs are read from the database so an admin can edit a game without a deploy, and
 * parsed on every read so a bad edit fails loudly here rather than mid-spin. Cached
 * briefly because a spin is a hot path.
 */
const configCache = new Map<string, { config: SlotConfig; at: number }>();
const CONFIG_TTL_MS = 10_000;

export function invalidateSlotConfigCache(slug?: string): void {
  if (slug) configCache.delete(slug);
  else configCache.clear();
}

interface GameRow {
  id: string;
  slug: string;
  isActive: boolean;
  config: SlotConfig;
}

async function loadGame(slug: string, client: Tx | typeof prisma = prisma): Promise<GameRow> {
  const row = await client.slotGame.findUnique({
    where: { slug },
    select: { id: true, slug: true, isActive: true, configJson: true },
  });
  if (!row) throw notFound("No such game", "GAME_NOT_FOUND");

  const cached = configCache.get(slug);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) {
    return { id: row.id, slug: row.slug, isActive: row.isActive, config: cached.config };
  }

  let parsed: SlotConfig;
  try {
    parsed = slotConfigSchema.parse(JSON.parse(row.configJson));
  } catch (error) {
    logger.error({ err: error, slug }, "stored slot config is invalid");
    throw conflict("GAME_CONFIG_INVALID", "This game is misconfigured and cannot be played");
  }

  configCache.set(slug, { config: parsed, at: Date.now() });
  return { id: row.id, slug: row.slug, isActive: row.isActive, config: parsed };
}

export async function listGames(includeInactive = false): Promise<SlotGameSummary[]> {
  const rows = await prisma.slotGame.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
    select: { slug: true, name: true, isActive: true, rtpTargetBp: true, configJson: true },
  });

  return rows.flatMap((row) => {
    try {
      const config = slotConfigSchema.parse(JSON.parse(row.configJson));
      return [
        {
          slug: row.slug,
          name: row.name,
          theme: config.theme,
          rtpTarget: row.rtpTargetBp / 10_000,
          betLevels: config.betLevels,
          isActive: row.isActive,
        },
      ];
    } catch {
      // A broken config must not take the whole lobby down with it.
      logger.error({ slug: row.slug }, "skipping game with invalid config in listing");
      return [];
    }
  });
}

/** The full config, for the paytable screen and the renderer. */
export async function getGameConfig(slug: string): Promise<SlotConfig> {
  return (await loadGame(slug)).config;
}

/* -------------------------------------------------------------------------- */
/* Spin                                                                       */
/* -------------------------------------------------------------------------- */

/** What we persist in `stopsJson` - enough to redraw the round exactly. */
interface StoredRound {
  stops: number[];
  grid: string[][];
  lineWins: SlotSpinResult["lineWins"];
  scatterWin: SlotSpinResult["scatterWin"];
  freeSpinsAwarded: number;
  isFreeSpin: boolean;
  multiplier: number;
}

function toResult(
  round: { id: string; bet: bigint; win: bigint; stopsJson: string },
  gameSlug: string,
  balance: bigint,
  freeSpinsRemaining: number,
): SlotSpinResult {
  const stored = JSON.parse(round.stopsJson) as StoredRound;
  return {
    roundId: round.id,
    gameSlug,
    stops: stored.stops,
    grid: stored.grid,
    bet: round.bet.toString(10),
    totalWin: round.win.toString(10),
    lineWins: stored.lineWins,
    scatterWin: stored.scatterWin,
    freeSpinsAwarded: stored.freeSpinsAwarded,
    isFreeSpin: stored.isFreeSpin,
    freeSpinsRemaining,
    balanceAfter: balance.toString(10),
  };
}

export interface SpinRequest {
  userId: string;
  gameSlug: string;
  /** Ignored while a free-spin session is running - the stored bet wins. */
  bet: bigint;
  idempotencyKey: string;
}

export async function spin(request: SpinRequest): Promise<SlotSpinResult> {
  const game = await loadGame(request.gameSlug);
  if (!game.isActive) {
    throw conflict("GAME_INACTIVE", "This game is not available to play");
  }

  // Replay check before anything moves. A retried spin must return its original round.
  const existing = await prisma.slotRound.findUnique({
    where: { idempotencyKey: request.idempotencyKey },
    select: { id: true, bet: true, win: true, stopsJson: true, gameId: true },
  });
  if (existing) {
    if (existing.gameId !== game.id) {
      throw conflict("IDEMPOTENCY_KEY_REUSED", "This spin key was used for a different game");
    }
    const [balance, remaining] = await Promise.all([
      currentBalance(request.userId),
      freeSpinsRemaining(request.userId, game.id),
    ]);
    return toResult(existing, game.slug, balance, remaining);
  }

  const result = await transact(request.userId, async ({ tx, debit, credit }) => {
    // Re-read the free-spin session inside the transaction: two spins racing must not
    // both consume the same free spin.
    const session = await tx.slotFreeSpinSession.findFirst({
      where: { userId: request.userId, gameId: game.id, remaining: { gt: 0 } },
      select: { id: true, bet: true, remaining: true, multiplier: true, triggerRoundId: true },
    });

    const isFreeSpin = session !== null;
    const bet = isFreeSpin ? session.bet : request.bet;

    if (!isFreeSpin) {
      if (!game.config.betLevels.includes(Number(bet))) {
        throw badRequest("INVALID_BET", "That bet is not offered on this game", {
          allowed: game.config.betLevels,
        });
      }
      await debit({
        amount: bet,
        type: "bet",
        refType: "slot_round",
        idempotencyKey: request.idempotencyKey,
      });
    }

    // THE OUTCOME. crypto.randomInt only - see CLAUDE.md rule 3.
    const stops = pickStops(game.config, secureRandomInt);
    const grid = buildGrid(game.config, stops);
    const multiplier = isFreeSpin ? session.multiplier : 1;
    const graded = evaluate(game.config, grid, { totalBet: bet, winMultiplier: multiplier });

    const stored: StoredRound = {
      stops,
      grid,
      lineWins: graded.lineWins,
      scatterWin: graded.scatterWin,
      freeSpinsAwarded: graded.freeSpinsAwarded,
      isFreeSpin,
      multiplier,
    };

    const round = await tx.slotRound.create({
      data: {
        userId: request.userId,
        gameId: game.id,
        // A free spin costs nothing, and recording it as zero keeps turnover honest.
        bet: isFreeSpin ? 0n : bet,
        win: graded.totalWin,
        stopsJson: JSON.stringify(stored),
        freeSpinParentId: isFreeSpin ? (session.triggerRoundId ?? null) : null,
        idempotencyKey: request.idempotencyKey,
      },
      select: { id: true, bet: true, win: true, stopsJson: true },
    });

    let balance: bigint;
    if (graded.totalWin > 0n) {
      const credited = await credit({
        amount: graded.totalWin,
        type: "win",
        refType: "slot_round",
        refId: round.id,
        idempotencyKey: `${request.idempotencyKey}-win`,
      });
      balance = credited.balance;
    } else {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: request.userId },
        select: { balance: true },
      });
      balance = wallet.balance;
    }

    // Consume this free spin, guarding on `remaining` so a race cannot overspend it.
    if (isFreeSpin) {
      const { count } = await tx.slotFreeSpinSession.updateMany({
        where: { id: session.id, remaining: { gt: 0 } },
        data: { remaining: { decrement: 1 } },
      });
      if (count !== 1) throw conflict("FREE_SPIN_RACE", "Please try that spin again");
    }

    // Award new free spins. Retriggering during a free spin is only honoured when the
    // config allows it, otherwise a bonus could extend itself indefinitely.
    let awarded = graded.freeSpinsAwarded;
    if (awarded > 0 && isFreeSpin && !game.config.scatter.retrigger) awarded = 0;

    if (awarded > 0) {
      const target = await tx.slotFreeSpinSession.findFirst({
        where: { userId: request.userId, gameId: game.id },
        select: { id: true },
      });

      if (target) {
        await tx.slotFreeSpinSession.update({
          where: { id: target.id },
          data: {
            remaining: { increment: awarded },
            bet: isFreeSpin ? session.bet : bet,
            multiplier: game.config.scatter.freeSpinMultiplier,
            triggerRoundId: round.id,
          },
        });
      } else {
        await tx.slotFreeSpinSession.create({
          data: {
            userId: request.userId,
            gameId: game.id,
            bet,
            remaining: awarded,
            multiplier: game.config.scatter.freeSpinMultiplier,
            triggerRoundId: round.id,
          },
        });
      }
    }

    const remainingAfter = await tx.slotFreeSpinSession.findFirst({
      where: { userId: request.userId, gameId: game.id },
      select: { remaining: true },
    });

    return {
      round,
      balance,
      wagered: isFreeSpin ? 0n : bet,
      won: graded.totalWin,
      freeSpinsRemaining: remainingAfter?.remaining ?? 0,
      // Report what the spin actually awarded, even if we declined to honour it, so the
      // client can still show the scatter win.
      awardedForDisplay: graded.freeSpinsAwarded,
    };
  });

  // VIP points accrue after the chips have moved, never before. Outside the transaction
  // because a VIP bookkeeping failure must not void a settled spin.
  if (result.wagered > 0n) {
    try {
      await recordWager(request.userId, result.wagered, result.won);
    } catch (error) {
      logger.error({ err: error, userId: request.userId }, "failed to record VIP wager for spin");
    }
  }

  return toResult(result.round, game.slug, result.balance, result.freeSpinsRemaining);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function currentBalance(userId: string): Promise<bigint> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { balance: true } });
  return wallet?.balance ?? 0n;
}

async function freeSpinsRemaining(userId: string, gameId: string): Promise<number> {
  const session = await prisma.slotFreeSpinSession.findFirst({
    where: { userId, gameId },
    select: { remaining: true },
  });
  return session?.remaining ?? 0;
}

export interface FreeSpinState {
  remaining: number;
  bet: string;
  multiplier: number;
}

export async function getFreeSpinState(
  userId: string,
  gameSlug: string,
): Promise<FreeSpinState | null> {
  const game = await loadGame(gameSlug);
  const session = await prisma.slotFreeSpinSession.findFirst({
    where: { userId, gameId: game.id, remaining: { gt: 0 } },
    select: { remaining: true, bet: true, multiplier: true },
  });
  if (!session) return null;
  return {
    remaining: session.remaining,
    bet: session.bet.toString(10),
    multiplier: session.multiplier,
  };
}

export interface SpinHistoryPage {
  rounds: Array<{
    roundId: string;
    gameSlug: string;
    bet: string;
    win: string;
    isFreeSpin: boolean;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

export async function getSpinHistory(
  userId: string,
  options: { limit: number; cursor?: string; gameSlug?: string },
): Promise<SpinHistoryPage> {
  const rows = await prisma.slotRound.findMany({
    where: {
      userId,
      ...(options.gameSlug ? { game: { slug: options.gameSlug } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      bet: true,
      win: true,
      stopsJson: true,
      createdAt: true,
      game: { select: { slug: true } },
    },
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    rounds: page.map((row) => ({
      roundId: row.id,
      gameSlug: row.game.slug,
      bet: row.bet.toString(10),
      win: row.win.toString(10),
      isFreeSpin: row.bet === 0n,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
