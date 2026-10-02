/**
 * The Prisma client, and the transaction helper the wallet depends on.
 *
 * Which schema was generated depends on DATABASE_PROVIDER (see prisma/run.mjs), but
 * the generated client's API is identical either way, so nothing above this file
 * knows which database is underneath - except the wallet, which has to care about
 * row locking.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { env, isProduction, isTest } from "./env.js";
import { logger } from "./logger.js";

export const prisma = new PrismaClient({
  log: isTest ? [] : isProduction ? ["warn", "error"] : ["warn", "error"],
});

/**
 * The client a `prisma.$transaction` callback receives.
 *
 * Prisma's own `TransactionClient` rather than a hand-rolled `Omit<PrismaClient, ...>`: the
 * two are structurally the same, but only the real one matches the `$transaction` overload
 * that takes an isolation level.
 */
export type Tx = Prisma.TransactionClient;

/**
 * Lock a wallet row and return the balance **as of the lock**.
 *
 * Returning the balance is not a convenience, it is the whole point. MySQL InnoDB
 * defaults to REPEATABLE READ, where the first plain SELECT in a transaction fixes a
 * consistent snapshot and every later plain SELECT reads from it. So this sequence is
 * broken even though it looks careful:
 *
 *     findUnique(wallet)          // fixes the snapshot
 *     SELECT ... FOR UPDATE       // serialises correctly, result discarded
 *     findUnique(wallet)          // STALE - reads the snapshot, not the locked row
 *
 * Twenty concurrent debits all read the pre-lock balance, all pass the "enough chips?"
 * check, and all write the same new value: a lost update that oversells the balance.
 * The lock did its job; the value acted on was stale. CI caught exactly this.
 *
 * The fix is to take the balance from the locking read itself, which by definition sees
 * the latest committed row. `walletTransaction` additionally runs at READ COMMITTED, so
 * the idempotency lookup cannot read a stale snapshot either.
 *
 * Returns null on SQLite, where there is no `FOR UPDATE` and the caller falls back to a
 * plain read guarded by the in-process mutex in `wallet.service.ts` - correct for exactly
 * one API process, which is why `env.ts` refuses SQLite in production.
 */
export async function lockWalletBalance(tx: Tx, walletId: string): Promise<bigint | null> {
  if (env.DATABASE_PROVIDER !== "mysql") return null;

  // Parameterised tagged template: the id is bound, never interpolated. Raw SQL is
  // unavoidable here because Prisma has no API for row-level locking.
  const rows = await tx.$queryRaw<
    Array<{ balance: bigint | number | string }>
  >`SELECT balance FROM wallets WHERE id = ${walletId} FOR UPDATE`;

  const balance = rows[0]?.balance;
  if (balance === undefined) return null;

  // Drivers differ on how they hand back BIGINT; normalise rather than assume.
  return typeof balance === "bigint" ? balance : BigInt(balance);
}

/**
 * Run a wallet transaction at READ COMMITTED on MySQL.
 *
 * REPEATABLE READ is InnoDB's default and is wrong for this work: every plain read in the
 * transaction would come from the snapshot taken by the first one, so the idempotency
 * lookup could miss an entry another transaction committed a moment earlier. READ COMMITTED
 * makes each statement see the latest committed data, which is the isolation level
 * `SELECT ... FOR UPDATE` is normally paired with.
 *
 * SQLite has one writer and Prisma rejects an isolation level for it, so the option is only
 * passed on MySQL.
 */
export async function walletTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  // The callback is wrapped in an inline arrow so TypeScript infers `tx` from Prisma's own
  // signature; passing `work` straight through makes it pick the batch-array overload instead.
  if (env.DATABASE_PROVIDER !== "mysql") return prisma.$transaction((tx) => work(tx));

  // The isolation level is a cast string, not `Prisma.TransactionIsolationLevel.ReadCommitted`.
  // Prisma generates that enum per provider, and SQLite's contains only `Serializable` - so
  // naming the member directly would fail to compile whenever the SQLite client is the one
  // generated, which is the prototype default. The cast compiles under both, and this branch
  // only runs on MySQL where the value is valid.
  return prisma.$transaction((tx) => work(tx), {
    isolationLevel: "ReadCommitted" as Prisma.TransactionIsolationLevel,
  });
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.debug("prisma disconnected");
}
