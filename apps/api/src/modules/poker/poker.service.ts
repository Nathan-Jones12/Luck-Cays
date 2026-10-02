/**
 * Poker tables: the live registry, the wallet boundary, and hand persistence.
 *
 * `table.ts` is the pure state machine. This file owns everything it must not: moving
 * chips in and out of the wallet, writing hands and actions to the database, and telling
 * the socket layer when to broadcast.
 *
 * The chip invariant: a buy-in debits the wallet and credits the seat; a cash-out does the
 * reverse. Chips are never created here, only moved, so
 * `sum(wallet balances) + sum(seat stacks)` is constant across the whole platform.
 */
import type { ActionType, PokerTableSummary, PokerTableView, Street } from "@luck-cays/shared";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { cardsToString } from "./cards.js";
import { credit, debit } from "../wallet/wallet.service.js";
import { recordWager } from "../vip/vip.service.js";
import { PokerTable, type CompletedHand, type TableConfig, type TableEvents } from "./table.js";

/** Set by the socket layer so state changes reach the players at a table. */
type Broadcaster = (tableId: string) => void;

let broadcast: Broadcaster = () => undefined;

export function setBroadcaster(fn: Broadcaster): void {
  broadcast = fn;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const tables = new Map<string, PokerTable>();

/**
 * Persistence is fire-and-forget on purpose: a slow database write must not stall the
 * action timer at a live table. Failures are logged loudly - the hand log is for auditing,
 * and a gap in it is a real problem, just not one worth freezing the game over.
 */
const events: TableEvents = {
  onStateChanged(table) {
    broadcast(table.config.id);
  },

  onHandStarted(table, handId, dealerSeat) {
    void prisma.pokerHand
      .create({ data: { id: handId, tableId: table.config.id, pot: 0n } })
      .catch((error: unknown) =>
        logger.error({ err: error, handId, dealerSeat }, "failed to persist hand start"),
      );
  },

  onAction(_table, action) {
    void prisma.pokerAction
      .create({
        data: {
          handId: action.handId,
          userId: action.userId,
          street: action.street,
          action: action.action,
          amount: action.amount,
          seq: action.seq,
        },
      })
      .catch((error: unknown) =>
        logger.error(
          { err: error, handId: action.handId, seq: action.seq },
          "failed to persist action",
        ),
      );
  },

  onHandComplete(table, hand) {
    void finishHand(table, hand).catch((error: unknown) =>
      logger.error({ err: error, handId: hand.handId }, "failed to finalise hand"),
    );
  },
};

async function finishHand(table: PokerTable, hand: CompletedHand): Promise<void> {
  await prisma.pokerHand.update({
    where: { id: hand.handId },
    data: {
      boardCards: cardsToString(hand.board),
      pot: hand.pot,
      endedAt: new Date(),
      winnersJson: JSON.stringify(
        hand.winners.map((winner) => ({
          seatNo: winner.seatNo,
          userId: winner.userId,
          username: winner.username,
          amount: winner.amount.toString(10),
          handName: winner.ranking?.name ?? null,
        })),
      ),
    },
  });

  // Keep the persisted stacks in step with the live table, so a restart does not lose
  // anyone's chips.
  await persistStacks(table);

  // VIP: poker turnover is what a player actually put in the pot this hand.
  for (const seat of table.occupiedSeats()) {
    if (!seat.userId) continue;
    const won = hand.winners.find((winner) => winner.seatNo === seat.seatNo)?.amount ?? 0n;
    if (won === 0n) continue;
    try {
      await recordWager(seat.userId, 0n, won);
    } catch (error) {
      logger.error({ err: error, userId: seat.userId }, "failed to record VIP win for poker hand");
    }
  }

  // Cash out anyone whose reconnect grace has run out.
  for (const seat of table.expiredDisconnects()) {
    if (seat.userId) {
      try {
        await leaveTable(seat.userId, table.config.id);
      } catch (error) {
        logger.error({ err: error, userId: seat.userId }, "failed to cash out dropped player");
      }
    }
  }

  // Deal the next hand if there are still two funded players.
  maybeStartHand(table.config.id);
}

async function persistStacks(table: PokerTable): Promise<void> {
  for (const seat of table.seats) {
    await prisma.pokerSeat.upsert({
      where: { tableId_seatNo: { tableId: table.config.id, seatNo: seat.seatNo } },
      create: {
        tableId: table.config.id,
        seatNo: seat.seatNo,
        userId: seat.userId,
        stack: seat.stack,
        sittingOut: seat.sittingOut,
        disconnectedAt: seat.disconnectedAt === null ? null : new Date(seat.disconnectedAt),
      },
      update: {
        userId: seat.userId,
        stack: seat.stack,
        sittingOut: seat.sittingOut,
        disconnectedAt: seat.disconnectedAt === null ? null : new Date(seat.disconnectedAt),
      },
    });
  }
}

async function loadTable(tableId: string): Promise<PokerTable> {
  const existing = tables.get(tableId);
  if (existing) return existing;

  const row = await prisma.pokerTable.findUnique({
    where: { id: tableId },
    select: {
      id: true,
      name: true,
      maxSeats: true,
      smallBlind: true,
      bigBlind: true,
      minBuyin: true,
      maxBuyin: true,
      isActive: true,
    },
  });
  if (!row) throw notFound("No such table", "TABLE_NOT_FOUND");
  if (!row.isActive) throw conflict("TABLE_CLOSED", "That table is closed");

  const config: TableConfig = {
    id: row.id,
    name: row.name,
    maxSeats: row.maxSeats,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    minBuyin: row.minBuyin,
    maxBuyin: row.maxBuyin,
  };

  const table = new PokerTable(config, events);
  tables.set(tableId, table);
  return table;
}

/** Start a hand if the table is ready. Safe to call whenever seating changes. */
function maybeStartHand(tableId: string): void {
  const table = tables.get(tableId);
  if (!table?.canStartHand()) return;

  // A beat between hands, so players can see the previous result before cards fly.
  const delay = setTimeout(() => {
    if (!table.canStartHand()) return;
    try {
      table.startHand(crypto.randomUUID());
    } catch (error) {
      logger.error({ err: error, tableId }, "failed to start hand");
    }
  }, 2_500);
  delay.unref?.();
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listTables(): Promise<PokerTableSummary[]> {
  const rows = await prisma.pokerTable.findMany({
    where: { isActive: true },
    orderBy: { bigBlind: "asc" },
    select: {
      id: true,
      name: true,
      maxSeats: true,
      smallBlind: true,
      bigBlind: true,
      minBuyin: true,
      maxBuyin: true,
      isActive: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    maxSeats: row.maxSeats,
    smallBlind: row.smallBlind.toString(10),
    bigBlind: row.bigBlind.toString(10),
    minBuyin: row.minBuyin.toString(10),
    maxBuyin: row.maxBuyin.toString(10),
    // From the live table when it exists, so the lobby shows who is actually sitting.
    seatedCount: tables.get(row.id)?.occupiedSeats().length ?? 0,
    isActive: row.isActive,
  }));
}

export async function viewTable(tableId: string, userId: string | null): Promise<PokerTableView> {
  const table = await loadTable(tableId);
  return table.viewFor(userId);
}

/* -------------------------------------------------------------------------- */
/* The wallet boundary                                                        */
/* -------------------------------------------------------------------------- */

export interface JoinRequest {
  userId: string;
  tableId: string;
  seatNo?: number;
  buyin: bigint;
}

/**
 * Take a seat.
 *
 * The wallet is debited first, then the seat is taken. If seating fails the chips are
 * refunded immediately - the alternative ordering (seat first, debit second) would let a
 * player sit with chips they could not afford.
 */
export async function joinTable(request: JoinRequest): Promise<PokerTableView> {
  const table = await loadTable(request.tableId);

  if (request.buyin < table.config.minBuyin || request.buyin > table.config.maxBuyin) {
    throw badRequest("INVALID_BUYIN", "That buy-in is outside this table's limits", {
      min: table.config.minBuyin.toString(10),
      max: table.config.maxBuyin.toString(10),
    });
  }

  if (table.seatOf(request.userId)) {
    throw conflict("ALREADY_SEATED", "You are already at this table");
  }

  const seatNo = request.seatNo ?? table.firstOpenSeat();
  if (seatNo === null) throw conflict("TABLE_FULL", "That table is full");

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: request.userId },
    select: { username: true },
  });

  await debit({
    userId: request.userId,
    amount: request.buyin,
    type: "poker_buyin",
    refType: "poker_table",
    refId: request.tableId,
    // Keyed on the table and timestamp: a retried join inside the same second is the same
    // buy-in, two deliberate buy-ins minutes apart are not.
    idempotencyKey: `poker-buyin-${request.userId}-${request.tableId}-${Math.floor(Date.now() / 1000)}`,
  });

  try {
    table.sit(seatNo, request.userId, user.username, request.buyin);
  } catch (error) {
    // Seating failed after the debit: give the chips straight back.
    await credit({
      userId: request.userId,
      amount: request.buyin,
      type: "refund",
      refType: "poker_table",
      refId: request.tableId,
    });
    throw error;
  }

  await persistStacks(table);
  maybeStartHand(request.tableId);
  broadcast(request.tableId);

  return table.viewFor(request.userId);
}

/** Leave, returning whatever is left of the stack to the wallet. */
export async function leaveTable(userId: string, tableId: string): Promise<{ returned: bigint }> {
  const table = await loadTable(tableId);
  const result = table.stand(userId);
  if (!result) throw conflict("NOT_SEATED", "You are not at this table");

  if (result.chips > 0n) {
    await credit({
      userId,
      amount: result.chips,
      type: "poker_cashout",
      refType: "poker_table",
      refId: tableId,
      idempotencyKey: `poker-cashout-${userId}-${tableId}-${Date.now()}`,
    });
  }

  await persistStacks(table);
  broadcast(tableId);

  return { returned: result.chips };
}

export async function setSittingOut(
  userId: string,
  tableId: string,
  sitOut: boolean,
): Promise<void> {
  const table = await loadTable(tableId);
  table.setSittingOut(userId, sitOut);
  await persistStacks(table);
  broadcast(tableId);
  if (!sitOut) maybeStartHand(tableId);
}

export async function act(
  userId: string,
  tableId: string,
  handId: string,
  action: ActionType,
  amount?: bigint,
): Promise<void> {
  const table = await loadTable(tableId);
  table.act(userId, handId, action, amount);
}

export async function markDisconnected(userId: string, tableId: string): Promise<void> {
  const table = tables.get(tableId);
  if (!table) return;
  table.markDisconnected(userId);
  broadcast(tableId);
}

export async function markReconnected(userId: string, tableId: string): Promise<void> {
  const table = tables.get(tableId);
  if (!table) return;
  table.markReconnected(userId);
  broadcast(tableId);
}

/** Which live tables a user is sitting at, for disconnect handling. */
export function tablesFor(userId: string): string[] {
  return [...tables.values()]
    .filter((table) => table.seatOf(userId) !== null)
    .map((table) => table.config.id);
}

export function streetOf(tableId: string): Street | null {
  return tables.get(tableId)?.viewFor(null).street ?? null;
}

/** Stop every table's timers so the process can exit cleanly. */
export function disposeTables(): void {
  for (const table of tables.values()) table.dispose();
  tables.clear();
}
