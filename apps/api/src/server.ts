/**
 * The entry point: HTTP server, Socket.IO gateway, scheduled jobs, graceful shutdown.
 *
 * Shutdown matters more than it looks. A poker table holds action timers and a player may be
 * mid-hand, so SIGTERM stops accepting connections, stops the jobs, disposes the tables'
 * timers and closes the database before exiting - rather than vanishing and leaving a hand
 * half-played with chips committed.
 */
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { disconnectPrisma, prisma } from "./lib/prisma.js";
import { disconnectRedis, usingRedis } from "./lib/redis.js";
import { closeSocketServer, createSocketServer } from "./sockets/index.js";
import { startJobs, stopJobs } from "./jobs/index.js";
import { disposeTables } from "./modules/poker/poker.service.js";

const app = createApp();
const httpServer = createServer(app);

createSocketServer(httpServer);

async function start(): Promise<void> {
  // Fail fast on a database that is not reachable, rather than serving 500s.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    logger.fatal({ err: error }, "cannot reach the database - check DATABASE_URL");
    process.exit(1);
  }

  startJobs();

  httpServer.listen(env.API_PORT, () => {
    logger.info(
      {
        port: env.API_PORT,
        environment: env.NODE_ENV,
        database: env.DATABASE_PROVIDER,
        redis: usingRedis ? "external" : "in-process",
        webOrigin: env.WEB_ORIGIN,
      },
      `Luck-Cays API listening on http://localhost:${env.API_PORT}`,
    );
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "shutting down");

  // Stop taking new work first, so nothing starts a hand we are about to abandon.
  stopJobs();
  disposeTables();

  const forced = setTimeout(() => {
    logger.error("shutdown timed out - exiting anyway");
    process.exit(1);
  }, 10_000);
  forced.unref();

  try {
    await closeSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await disconnectRedis();
    await disconnectPrisma();
    clearTimeout(forced);
    logger.info("shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * An unhandled rejection means some promise escaped its error handling. Log it and keep
 * serving rather than dropping every player's session over one bad request path.
 */
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});

// An uncaught exception leaves the process in an unknown state, so this one does exit.
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception - exiting");
  void shutdown("uncaughtException");
});

void start();
