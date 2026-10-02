/**
 * Poker socket handlers.
 *
 * Every inbound message is parsed by a zod schema from `packages/shared` before it reaches
 * the state machine - a socket payload is exactly as untrusted as a request body, and
 * sockets have no middleware chain to do it for them.
 *
 * Broadcasts go out per viewer, not per room. A single room-wide emit would send one
 * payload to everyone, and that payload would have to contain every player's hole cards.
 * So the gateway walks the sockets in the room and sends each one its own projection.
 */
import {
  chipsFromJson,
  joinTableSchema,
  leaveTableSchema,
  pokerActionSchema,
  POKER_EVENTS,
  sitOutSchema,
} from "@luck-cays/shared";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parseSocketMessage } from "../middleware/validate.js";
import * as poker from "../modules/poker/poker.service.js";
import { getIo, type AppSocket } from "./index.js";

const tableRoom = (tableId: string) => `poker:${tableId}`;

/**
 * Send each socket in a table's room its own view.
 *
 * This is the security boundary for hole cards, so it must stay the only way table state
 * leaves the server.
 */
async function broadcastTable(tableId: string): Promise<void> {
  const io = getIo();
  const sockets = await io.in(tableRoom(tableId)).fetchSockets();

  for (const socket of sockets) {
    const userId = (socket.data as { userId?: string }).userId ?? null;
    try {
      socket.emit(POKER_EVENTS.state, await poker.viewTable(tableId, userId));
    } catch (error) {
      logger.error({ err: error, tableId, userId }, "failed to send table state");
    }
  }
}

/** Registered once, so the service can broadcast without importing the socket layer. */
poker.setBroadcaster((tableId) => {
  void broadcastTable(tableId).catch((error: unknown) =>
    logger.error({ err: error, tableId }, "table broadcast failed"),
  );
});

/** Report an error to one socket without leaking internals. */
function fail(socket: AppSocket, error: unknown): void {
  if (error instanceof AppError) {
    socket.emit(POKER_EVENTS.error, {
      code: error.code,
      message: error.message,
      details: error.details,
    });
    return;
  }
  logger.error({ err: error, userId: socket.data.userId }, "unhandled poker socket error");
  socket.emit(POKER_EVENTS.error, { code: "INTERNAL_ERROR", message: "Something went wrong" });
}

export function registerPokerHandlers(socket: AppSocket): void {
  const { userId } = socket.data;

  socket.on(POKER_EVENTS.join, async (payload: unknown) => {
    try {
      const input = parseSocketMessage(joinTableSchema, payload);

      await socket.join(tableRoom(input.tableId));
      await poker.markReconnected(userId, input.tableId);

      // Already seated: this is a reconnect, so just resend the state rather than buying in
      // a second time.
      const existing = await poker.viewTable(input.tableId, userId);
      if (existing.yourSeat !== null) {
        socket.emit(POKER_EVENTS.state, existing);
        return;
      }

      await poker.joinTable({
        userId,
        tableId: input.tableId,
        ...(input.seatNo === undefined ? {} : { seatNo: input.seatNo }),
        buyin: chipsFromJson(input.buyin),
      });
    } catch (error) {
      fail(socket, error);
    }
  });

  socket.on(POKER_EVENTS.leave, async (payload: unknown) => {
    try {
      const input = parseSocketMessage(leaveTableSchema, payload);
      await poker.leaveTable(userId, input.tableId);
      await socket.leave(tableRoom(input.tableId));
    } catch (error) {
      fail(socket, error);
    }
  });

  socket.on(POKER_EVENTS.sitOut, async (payload: unknown) => {
    try {
      const input = parseSocketMessage(sitOutSchema, payload);
      await poker.setSittingOut(userId, input.tableId, input.sitOut);
    } catch (error) {
      fail(socket, error);
    }
  });

  socket.on(POKER_EVENTS.action, async (payload: unknown) => {
    try {
      const input = parseSocketMessage(pokerActionSchema, payload);
      await poker.act(
        userId,
        input.tableId,
        input.handId,
        input.action,
        input.amount === undefined ? undefined : chipsFromJson(input.amount),
      );
    } catch (error) {
      fail(socket, error);
    }
  });

  /**
   * On disconnect the seat is only MARKED dropped, never vacated. Vacating it would forfeit
   * chips already committed to a live pot; the table folds the seat after the grace period
   * and `finishHand` cashes it out then.
   */
  socket.on("disconnect", () => {
    for (const tableId of poker.tablesFor(userId)) {
      void poker.markDisconnected(userId, tableId);
    }
  });
}
