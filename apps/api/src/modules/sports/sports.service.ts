/**
 * Sports betting: fixtures, markets, bet placement and settlement.
 *
 * Odds are integers scaled by 100 everywhere (250 means 2.50), so a payout is
 * `stake * oddsInt / 100` in exact integer arithmetic. Decimal odds as a float would
 * eventually pay someone a chip too few.
 *
 * Odds are locked at placement. If the stored odds have moved since the player saw them,
 * the bet is rejected with `ODDS_CHANGED` and the current price, so the client can ask
 * rather than silently repricing the bet.
 */
import type {
  BetStatus,
  MarketType,
  Selection,
  SportsBet as SportsBetDto,
  SportsEvent as SportsEventDto,
} from "@luck-cays/shared";
import { badRequest, conflict, notFound, oddsChanged } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma, type Tx } from "../../lib/prisma.js";
import { recordWager } from "../vip/vip.service.js";
import { transact } from "../wallet/wallet.service.js";

/* ------------------------------- odds helpers ------------------------------ */

/** "2.50" -> 250. The schema has already checked the shape. */
export function oddsToInt(odds: string): number {
  const [whole = "0", fraction = "00"] = odds.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

/** 250 -> "2.50". */
export function oddsToString(oddsInt: number): string {
  return `${Math.floor(oddsInt / 100)}.${String(oddsInt % 100).padStart(2, "0")}`;
}

/** Moneyline markets store an empty line; the API reports that as null. */
function lineToDto(line: string): string | null {
  return line === "" ? null : line;
}

/** Total returned on a winning bet, stake included. Exact integer arithmetic. */
export function potentialReturn(stake: bigint, oddsInt: number): bigint {
  return (stake * BigInt(oddsInt)) / 100n;
}

/* ------------------------------ stored shapes ------------------------------ */

interface StoredSelection {
  key: string;
  label: string;
  oddsInt: number;
}

function parseSelections(json: string): StoredSelection[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("market selections are not an array");
  return parsed as StoredSelection[];
}

function toSelectionDto(selection: StoredSelection): Selection {
  return { key: selection.key, label: selection.label, odds: oddsToString(selection.oddsInt) };
}

interface StoredResult {
  homeScore: number;
  awayScore: number;
}

/* --------------------------------- reads ----------------------------------- */

export interface EventsPage {
  events: SportsEventDto[];
  nextCursor: string | null;
}

export async function listEvents(options: {
  limit: number;
  cursor?: string;
  sport?: string;
  league?: string;
}): Promise<EventsPage> {
  const rows = await prisma.sportsEvent.findMany({
    where: {
      // Pre-match only in v1, so only fixtures that have not started are offered.
      status: "scheduled",
      startsAt: { gt: new Date() },
      ...(options.sport ? { sport: options.sport } : {}),
      ...(options.league ? { league: options.league } : {}),
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: { markets: { where: { status: "open" }, orderBy: { type: "asc" } } },
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    events: page.map((row) => ({
      id: row.id,
      sport: row.sport,
      league: row.league,
      home: row.home,
      away: row.away,
      startsAt: row.startsAt.toISOString(),
      status: row.status as SportsEventDto["status"],
      result: row.resultJson ? (JSON.parse(row.resultJson) as StoredResult) : null,
      markets: row.markets.map((market) => ({
        id: market.id,
        type: market.type as MarketType,
        line: lineToDto(market.line),
        status: market.status as SportsEventDto["markets"][number]["status"],
        selections: parseSelections(market.selectionsJson).map(toSelectionDto),
      })),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function listSports(): Promise<
  Array<{ sport: string; leagues: string[]; count: number }>
> {
  const rows = await prisma.sportsEvent.findMany({
    where: { status: "scheduled", startsAt: { gt: new Date() } },
    select: { sport: true, league: true },
  });

  const grouped = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!grouped.has(row.sport)) grouped.set(row.sport, new Set());
    grouped.get(row.sport)?.add(row.league);
    counts.set(row.sport, (counts.get(row.sport) ?? 0) + 1);
  }

  return [...grouped.entries()].map(([sport, leagues]) => ({
    sport,
    leagues: [...leagues].sort(),
    count: counts.get(sport) ?? 0,
  }));
}

/* ------------------------------- placement --------------------------------- */

export interface PlaceBetRequest {
  userId: string;
  marketId: string;
  selection: string;
  /** The odds the player saw, as a decimal string. */
  odds: string;
  stake: bigint;
  idempotencyKey: string;
  acceptOddsChange: boolean;
}

export async function placeBet(request: PlaceBetRequest): Promise<SportsBetDto> {
  // Replay first: a retried placement must return the original bet, not stake again.
  const existing = await prisma.sportsBet.findUnique({
    where: { idempotencyKey: request.idempotencyKey },
    select: { id: true },
  });
  if (existing) return getBet(request.userId, existing.id);

  if (request.stake <= 0n) throw badRequest("INVALID_STAKE", "Stake must be greater than zero");

  const market = await prisma.sportsMarket.findUnique({
    where: { id: request.marketId },
    select: {
      id: true,
      status: true,
      selectionsJson: true,
      event: { select: { id: true, status: true, startsAt: true } },
    },
  });
  if (!market) throw notFound("No such market", "MARKET_NOT_FOUND");

  if (market.status !== "open") {
    throw conflict("MARKET_CLOSED", "This market is no longer taking bets");
  }
  if (market.event.status !== "scheduled" || market.event.startsAt.getTime() <= Date.now()) {
    // v1 is pre-match only.
    throw conflict("EVENT_STARTED", "This event has already started");
  }

  const selections = parseSelections(market.selectionsJson);
  const chosen = selections.find((selection) => selection.key === request.selection);
  if (!chosen) throw badRequest("UNKNOWN_SELECTION", "That selection is not in this market");

  const submittedOddsInt = oddsToInt(request.odds);
  if (submittedOddsInt !== chosen.oddsInt && !request.acceptOddsChange) {
    throw oddsChanged(request.odds, oddsToString(chosen.oddsInt));
  }

  // Always settle at the stored price, never the submitted one - otherwise a client
  // could name its own odds by setting acceptOddsChange.
  const oddsInt = chosen.oddsInt;
  const potentialWin = potentialReturn(request.stake, oddsInt);

  const betId = await transact(request.userId, async ({ tx, debit }) => {
    await debit({
      amount: request.stake,
      type: "bet",
      refType: "sports_bet",
      idempotencyKey: request.idempotencyKey,
    });

    const bet = await tx.sportsBet.create({
      data: {
        userId: request.userId,
        marketId: market.id,
        selection: chosen.key,
        oddsInt,
        stake: request.stake,
        potentialWin,
        status: "open",
        idempotencyKey: request.idempotencyKey,
      },
      select: { id: true },
    });

    return bet.id;
  });

  // Wagering counts toward VIP at placement. The win, if any, is recorded at settlement.
  try {
    await recordWager(request.userId, request.stake, 0n);
  } catch (error) {
    logger.error({ err: error, userId: request.userId }, "failed to record VIP wager for bet");
  }

  return getBet(request.userId, betId);
}

/* --------------------------------- bet reads -------------------------------- */

const BET_INCLUDE = {
  market: {
    select: {
      type: true,
      line: true,
      selectionsJson: true,
      event: {
        select: {
          home: true,
          away: true,
          sport: true,
          league: true,
          startsAt: true,
          status: true,
          resultJson: true,
        },
      },
    },
  },
} as const;

type BetRow = {
  id: string;
  selection: string;
  oddsInt: number;
  stake: bigint;
  potentialWin: bigint;
  status: string;
  settledAt: Date | null;
  createdAt: Date;
  market: {
    type: string;
    line: string;
    selectionsJson: string;
    event: {
      home: string;
      away: string;
      sport: string;
      league: string;
      startsAt: Date;
      status: string;
      resultJson: string | null;
    };
  };
};

function toBetDto(row: BetRow): SportsBetDto {
  const selections = parseSelections(row.market.selectionsJson);
  const label = selections.find((s) => s.key === row.selection)?.label ?? row.selection;

  return {
    id: row.id,
    event: {
      home: row.market.event.home,
      away: row.market.event.away,
      sport: row.market.event.sport,
      league: row.market.event.league,
      startsAt: row.market.event.startsAt.toISOString(),
      status: row.market.event.status as SportsBetDto["event"]["status"],
      result: row.market.event.resultJson
        ? (JSON.parse(row.market.event.resultJson) as StoredResult)
        : null,
    },
    market: { type: row.market.type as MarketType, line: lineToDto(row.market.line) },
    selection: row.selection,
    selectionLabel: label,
    odds: oddsToString(row.oddsInt),
    stake: row.stake.toString(10),
    potentialWin: row.potentialWin.toString(10),
    status: row.status as BetStatus,
    settledAt: row.settledAt?.toISOString() ?? null,
    placedAt: row.createdAt.toISOString(),
  };
}

export async function getBet(userId: string, betId: string): Promise<SportsBetDto> {
  const row = await prisma.sportsBet.findFirst({
    where: { id: betId, userId },
    include: BET_INCLUDE,
  });
  if (!row) throw notFound("No such bet", "BET_NOT_FOUND");
  return toBetDto(row as BetRow);
}

export interface BetsPage {
  bets: SportsBetDto[];
  nextCursor: string | null;
}

export async function listBets(
  userId: string,
  options: { limit: number; cursor?: string; status?: BetStatus },
): Promise<BetsPage> {
  const rows = await prisma.sportsBet.findMany({
    where: { userId, ...(options.status ? { status: options.status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: BET_INCLUDE,
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    bets: page.map((row) => toBetDto(row as BetRow)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/* -------------------------------- settlement -------------------------------- */

export type Grade = Extract<BetStatus, "won" | "lost" | "push">;

/**
 * Grade one bet against a final score. Pure, so it is unit-testable without a database -
 * and it is the piece most worth testing, because a grading bug pays or robs real
 * players.
 *
 * Lines are strings in the database to keep floats out of the money path, but a handicap
 * is genuinely fractional, so it is parsed to a number here. That is safe: the comparison
 * is against an integer score difference, and half-point lines exist precisely so the
 * comparison can never land exactly on the line.
 */
export function gradeBet(
  market: { type: MarketType; line: string },
  selection: string,
  result: StoredResult,
): Grade {
  const { homeScore, awayScore } = result;

  switch (market.type) {
    case "moneyline": {
      if (homeScore === awayScore) return selection === "draw" ? "won" : "lost";
      const winner = homeScore > awayScore ? "home" : "away";
      return selection === winner ? "won" : "lost";
    }

    case "spread": {
      // The line is applied to the home side: -3.5 means home must win by 4 or more.
      const line = Number(market.line);
      const adjusted = homeScore + line - awayScore;
      if (adjusted === 0) return "push";
      const covering = adjusted > 0 ? "home" : "away";
      return selection === covering ? "won" : "lost";
    }

    case "totals": {
      const line = Number(market.line);
      const total = homeScore + awayScore;
      if (total === line) return "push";
      const covering = total > line ? "over" : "under";
      return selection === covering ? "won" : "lost";
    }
  }
}

export interface SettlementRun {
  graded: number;
  won: number;
  lost: number;
  push: number;
  paidOut: bigint;
}

/**
 * Settle every open bet on events that now have a result.
 *
 * A won bet is credited its full return (stake included, since the stake was debited at
 * placement). A push refunds the stake. Payouts are keyed on the bet id, so running the
 * job twice cannot pay twice.
 */
export async function settleResolvedEvents(): Promise<SettlementRun> {
  const events = await prisma.sportsEvent.findMany({
    where: { status: "final", resultJson: { not: null } },
    select: {
      id: true,
      resultJson: true,
      markets: {
        select: {
          id: true,
          type: true,
          line: true,
          bets: {
            where: { status: "open" },
            select: { id: true, userId: true, selection: true, stake: true, potentialWin: true },
          },
        },
      },
    },
  });

  const run: SettlementRun = { graded: 0, won: 0, lost: 0, push: 0, paidOut: 0n };

  for (const event of events) {
    const result = JSON.parse(event.resultJson as string) as StoredResult;

    for (const market of event.markets) {
      for (const bet of market.bets) {
        const grade = gradeBet(
          { type: market.type as MarketType, line: market.line },
          bet.selection,
          result,
        );
        await applyGrade(bet, grade, run);
      }

      if (market.bets.length > 0) {
        await prisma.sportsMarket.update({ where: { id: market.id }, data: { status: "settled" } });
      }
    }
  }

  if (run.graded > 0) logger.info({ ...run, paidOut: run.paidOut.toString() }, "settlement run");
  return run;
}

async function applyGrade(
  bet: { id: string; userId: string; selection: string; stake: bigint; potentialWin: bigint },
  grade: Grade,
  run: SettlementRun,
): Promise<void> {
  // A push returns the stake; a win returns the whole potential return.
  const payout = grade === "won" ? bet.potentialWin : grade === "push" ? bet.stake : 0n;

  await transact(bet.userId, async ({ tx, credit }) => {
    // Guard on `status: "open"` so two concurrent settlement runs cannot both pay.
    const { count } = await tx.sportsBet.updateMany({
      where: { id: bet.id, status: "open" },
      data: { status: grade, settledAt: new Date() },
    });
    if (count !== 1) return;

    if (payout > 0n) {
      await credit({
        amount: payout,
        type: grade === "push" ? "refund" : "win",
        refType: "sports_bet",
        refId: bet.id,
        idempotencyKey: `sports-settle-${bet.id}`,
      });
    }

    run.graded += 1;
    run[grade] += 1;
    run.paidOut += payout;
  });

  // A winning bet's profit counts toward VIP net position at settlement.
  if (grade === "won") {
    try {
      await recordWager(bet.userId, 0n, bet.potentialWin);
    } catch (error) {
      logger.error({ err: error, betId: bet.id }, "failed to record VIP win for settled bet");
    }
  }
}

/** Record a final score, which makes the event eligible for settlement. */
export async function setEventResult(
  eventId: string,
  result: StoredResult,
  tx: Tx | typeof prisma = prisma,
): Promise<void> {
  await tx.sportsEvent.update({
    where: { id: eventId },
    data: { status: "final", resultJson: JSON.stringify(result) },
  });
}

/**
 * Void a bet and refund the stake. Used by admins when an event is cancelled or a market
 * was priced wrongly.
 */
export async function voidBet(betId: string): Promise<void> {
  const bet = await prisma.sportsBet.findUnique({
    where: { id: betId },
    select: { id: true, userId: true, stake: true, status: true },
  });
  if (!bet) throw notFound("No such bet", "BET_NOT_FOUND");
  if (bet.status !== "open") throw conflict("BET_ALREADY_SETTLED", "That bet is already settled");

  await transact(bet.userId, async ({ tx, credit }) => {
    const { count } = await tx.sportsBet.updateMany({
      where: { id: bet.id, status: "open" },
      data: { status: "void", settledAt: new Date() },
    });
    if (count !== 1) return;

    await credit({
      amount: bet.stake,
      type: "refund",
      refType: "sports_bet",
      refId: bet.id,
      idempotencyKey: `sports-void-${bet.id}`,
    });
  });
}
