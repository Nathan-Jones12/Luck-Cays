/**
 * The Socket.IO gateway.
 *
 * Every connection authenticates with the access token before any handler is wired up, so
 * there is no window in which an unauthenticated socket can emit. Each socket joins a room
 * named for its user, which is how the wallet pushes balance updates to every tab a player
 * has open.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { WALLET_EVENTS } from "@luck-cays/shared";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { registerPokerHandlers } from "./poker.socket.js";

export interface SocketAuth {
  userId: string;
  username: string;
  role: string;
}

/** Sockets carry their identity on `socket.data`, set once during the handshake. */
export interface AppSocket extends Socket {
  data: SocketAuth;
}

let io: Server | null = null;

export function getIo(): Server {
  if (!io) throw new Error("socket.io has not been initialised");
  return io;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Push a balance to every socket this user has open. */
export function emitBalance(userId: string, balance: bigint): void {
  io?.to(userRoom(userId)).emit(WALLET_EVENTS.balance, { balance: balance.toString(10) });
}

export function createSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    // Long enough to survive a brief network blip without dropping a seated player.
    pingTimeout: 20_000,
    pingInterval: 10_000,
  });

  /**
   * Authenticate during the handshake, not after connect.
   *
   * The account's status is re-read here rather than trusted from the token: a 15-minute
   * token must not let a banned player keep a seat.
   */
  // Socket.IO's middleware signature is synchronous, so the async work is wrapped rather than
  // handed over as a promise the library would ignore. An unhandled rejection here would leave
  // the handshake hanging forever instead of being refused.
  io.use((socket, next) => {
    void (async () => {
      try {
        const token =
          (socket.handshake.auth as { token?: unknown } | undefined)?.token ??
          socket.handshake.headers.authorization?.replace(/^Bearer /, "");

        if (typeof token !== "string" || token.length === 0) {
          next(new Error("UNAUTHORIZED"));
          return;
        }

        const claims = await verifyAccessToken(token);
        const user = await prisma.user.findUnique({
          where: { id: claims.sub },
          select: { id: true, username: true, role: true, status: true },
        });

        if (!user || user.status !== "active") {
          next(new Error("UNAUTHORIZED"));
          return;
        }

        socket.data = { userId: user.id, username: user.username, role: user.role };
        next();
      } catch {
        // Deliberately opaque: a socket error message should not say why a token failed.
        next(new Error("UNAUTHORIZED"));
      }
    })();
  });

  io.on("connection", (socket) => {
    const { userId, username } = socket.data as SocketAuth;

    void socket.join(userRoom(userId));
    logger.debug({ userId, socketId: socket.id }, "socket connected");

    registerPokerHandlers(socket as AppSocket);

    socket.on("disconnect", (reason) => {
      logger.debug({ userId, username, reason }, "socket disconnected");
    });
  });

  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}
