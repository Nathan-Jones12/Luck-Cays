/**
 * The Prisma client, and the transaction helper the wallet depends on.
 *
 * Which schema was generated depends on DATABASE_PROVIDER (see prisma/run.mjs), but
 * the generated client's API is identical either way, so nothing above this file
 * knows which database is underneath - except the wallet, which has to care about
 * row locking.
 */
import { PrismaClient } from "@prisma/client";
import { env, isProduction, isTest } from "./env.js";
import { logger } from "./logger.js";

export const prisma = new PrismaClient({
  log: isTest ? [] : isProduction ? ["warn", "error"] : ["warn", "error"],
});

/** The type a `prisma.$transaction` callback receives. */
export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Lock a wallet row for the rest of the transaction.
 *
 * LOCKING: on MySQL this is a real `SELECT ... FOR UPDATE`, so concurrent debits on
 * the same wallet serialise at the database and the guarantee holds across as many
 * API instances as you like.
 *
 * On SQLite there is no `FOR UPDATE`. Writes serialise at the file level, but that
 * is not enough on its own: two debits could each read the same balance before
 * either writes, and both pass the "enough chips?" check. The wallet therefore also
 * takes an in-process mutex per wallet (see `wallet.service.ts`), which is correct
 * for exactly one API process. Running two against one SQLite file can oversell a
 * balance - which is why `env.ts` refuses `sqlite` in production.
 */
export async function lockWallet(tx: Tx, walletId: string): Promise<void> {
  if (env.DATABASE_PROVIDER !== "mysql") return;

  // Parameterised tagged template: the id is bound, never interpolated. Raw SQL is
  // unavoidable here because Prisma has no API for row-level locking.
  await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.debug("prisma disconnected");
}
