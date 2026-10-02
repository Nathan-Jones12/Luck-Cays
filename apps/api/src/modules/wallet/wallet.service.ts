/**
 * The wallet. The ONLY code in this repo that changes a balance.
 *
 * Everything else - slots, sports, poker, VIP, admin - moves chips by calling
 * `debit`, `credit` or `transact` here. No other module may UPDATE `wallets` or
 * INSERT into `ledger_entries`. That rule is what makes the ledger trustworthy and
 * what lets this be swapped for a real-money wallet later without auditing every
 * game.
 *
 * Four guarantees, each with a test in `tests/`:
 *
 *  1. WHOLE CHIPS. Amounts are `bigint` throughout. No float, ever.
 *  2. NEVER NEGATIVE. A debit that would take a balance below zero is rejected.
 *  3. APPEND-ONLY LEDGER. Every movement writes a row carrying `balanceAfter`, and
 *     rows are never updated or deleted. The sum of `amount` must equal the balance.
 *  4. IDEMPOTENT. A movement carrying an idempotency key runs at most once. Replaying
 *     the key returns the original result rather than moving chips again.
 */
import type { LedgerType } from "@luck-cays/shared";
import { conflict, idempotencyConflict, insufficientFunds, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { lockWalletBalance, prisma, walletTransaction, type Tx } from "../../lib/prisma.js";
import { usesSqlite } from "../../lib/env.js";

export interface MovementInput {
  userId: string;
  /** Always positive. `debit` subtracts it, `credit` adds it. */
  amount: bigint;
  type: LedgerType;
  /** What caused this, e.g. `{ refType: "slot_round", refId }`. */
  refType?: string;
  refId?: string;
  /**
   * Required for anything a client can retry. Omit only for server-initiated
   * movements where no retry is possible (a settlement job writing its own result).
   */
  idempotencyKey?: string;
}

export interface MovementResult {
  balance: bigint;
  ledgerEntryId: string;
  /** True when an existing entry was returned instead of chips moving again. */
  replayed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Serialisation on SQLite                                                    */
/* -------------------------------------------------------------------------- */

/**
 * LOCKING: on MySQL, `lockWalletBalance` issues `SELECT balance ... FOR UPDATE` and the
 * database serialises concurrent debits on the same wallet. That holds across any number
 * of API instances and is the production path. Crucially the balance comes back from that
 * locking read - a plain re-read would return the transaction's snapshot instead, which is
 * a lost update waiting to happen. See the note on `lockWalletBalance`.
 *
 * SQLite has no `FOR UPDATE`. File-level write locking is not sufficient on its own,
 * because two debits can both *read* the same balance before either writes, and both
 * then pass the "enough chips?" check - a classic lost update that oversells the
 * balance. So on SQLite we additionally serialise per wallet in this process with a
 * promise chain.
 *
 * This is correct for exactly one API process. Two processes against one SQLite file
 * can still oversell, which is why `env.ts` refuses `sqlite` in production.
 */
const walletQueues = new Map<string, Promise<void>>();

function serialisePerWallet<T>(walletKey: string, work: () => Promise<T>): Promise<T> {
  if (!usesSqlite) return work();

  const previous = walletQueues.get(walletKey) ?? Promise.resolve();

  // `then(work, work)` runs the next job whether the previous one resolved or threw:
  // one caller's insufficient-funds rejection must not block the queue behind it.
  const result = previous.then(work, work);

  // The tail is a void promise that never rejects, so an unhandled rejection here
  // cannot take the process down.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  walletQueues.set(walletKey, tail);

  // Once settled, drop the entry if nothing else has queued behind it. Without this
  // the map would retain one promise per wallet seen, forever.
  void tail.then(() => {
    if (walletQueues.get(walletKey) === tail) walletQueues.delete(walletKey);
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getOrCreateWallet(userId: string): Promise<{ id: string; balance: bigint }> {
  const existing = await prisma.wallet.findUnique({
    where: { userId },
    select: { id: true, balance: true },
  });
  if (existing) return existing;

  return prisma.wallet.create({
    data: { userId, balance: 0n },
    select: { id: true, balance: true },
  });
}

export async function getBalance(userId: string): Promise<bigint> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { balance: true } });
  if (!wallet) throw notFound("Wallet not found", "WALLET_NOT_FOUND");
  return wallet.balance;
}

export interface LedgerPage {
  entries: Array<{
    id: string;
    amount: bigint;
    type: string;
    refType: string | null;
    refId: string | null;
    balanceAfter: bigint;
    createdAt: Date;
  }>;
  nextCursor: string | null;
}

export async function getLedger(
  userId: string,
  options: { limit: number; cursor?: string; type?: string },
): Promise<LedgerPage> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) throw notFound("Wallet not found", "WALLET_NOT_FOUND");

  // Fetch one extra row to know whether another page exists.
  const rows = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id, ...(options.type ? { type: options.type } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      amount: true,
      type: true,
      refType: true,
      refId: true,
      balanceAfter: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > options.limit;
  const entries = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    entries,
    nextCursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

function assertPositive(amount: bigint): void {
  if (amount <= 0n) {
    throw conflict("INVALID_AMOUNT", "Amount must be greater than zero");
  }
}

/**
 * Has this key already moved chips? If so, return the original entry so the caller
 * can replay its result rather than charging twice.
 */
async function findReplay(
  tx: Tx,
  idempotencyKey: string,
  expected: { walletId: string; amount: bigint; type: string },
): Promise<{ id: string; balanceAfter: bigint } | null> {
  const existing = await tx.ledgerEntry.findUnique({
    where: { idempotencyKey },
    select: { id: true, walletId: true, amount: true, type: true, balanceAfter: true },
  });
  if (!existing) return null;

  // Same key, different movement: the client has a bug, and honouring it would
  // either double-charge or silently drop a bet. Say so instead.
  const matches =
    existing.walletId === expected.walletId &&
    existing.amount === expected.amount &&
    existing.type === expected.type;

  if (!matches) throw idempotencyConflict(idempotencyKey);

  return { id: existing.id, balanceAfter: existing.balanceAfter };
}

/**
 * Apply a signed delta to a wallet inside an already-open transaction.
 *
 * `signedAmount` is negative for a debit. The wallet row is locked first, so the
 * balance read here cannot be stale by the time it is written.
 */
async function applyMovement(
  tx: Tx,
  input: MovementInput & { signedAmount: bigint },
): Promise<MovementResult> {
  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
    select: { id: true, balance: true },
  });
  if (!wallet) throw notFound("Wallet not found", "WALLET_NOT_FOUND");

  // Take the lock AND the balance in one statement. On MySQL a plain re-read here would
  // return the transaction's snapshot rather than the locked row - see the long note on
  // `lockWalletBalance`. This is the value every later decision is made on.
  const lockedBalance = await lockWalletBalance(tx, wallet.id);

  if (input.idempotencyKey) {
    const replay = await findReplay(tx, input.idempotencyKey, {
      walletId: wallet.id,
      amount: input.signedAmount,
      type: input.type,
    });
    if (replay) {
      return { balance: replay.balanceAfter, ledgerEntryId: replay.id, replayed: true };
    }
  }

  // On SQLite there is no locking read, so fall back to the value already fetched. The
  // in-process mutex is what makes that safe there.
  const current = lockedBalance ?? wallet.balance;

  const next = current + input.signedAmount;
  if (next < 0n) throw insufficientFunds(-input.signedAmount, current);

  await tx.wallet.update({ where: { id: wallet.id }, data: { balance: next } });

  const entry = await tx.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      amount: input.signedAmount,
      type: input.type,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      balanceAfter: next,
    },
    select: { id: true },
  });

  return { balance: next, ledgerEntryId: entry.id, replayed: false };
}

/** Take chips away. Rejected if the balance would go below zero. */
export async function debit(input: MovementInput): Promise<MovementResult> {
  assertPositive(input.amount);
  return serialisePerWallet(input.userId, () =>
    walletTransaction((tx) => applyMovement(tx, { ...input, signedAmount: -input.amount })),
  );
}

/** Add chips. */
export async function credit(input: MovementInput): Promise<MovementResult> {
  assertPositive(input.amount);
  return serialisePerWallet(input.userId, () =>
    walletTransaction((tx) => applyMovement(tx, { ...input, signedAmount: input.amount })),
  );
}

export interface TransactContext {
  tx: Tx;
  debit(input: Omit<MovementInput, "userId">): Promise<MovementResult>;
  credit(input: Omit<MovementInput, "userId">): Promise<MovementResult>;
}

/**
 * Run several movements and the caller's own writes in ONE transaction.
 *
 * A slot spin needs this: debit the bet, record the round, credit the win. Doing it
 * as three independent calls would leave a window where chips have been taken and
 * the round does not exist yet, and a crash in that window loses the bet with nothing
 * to show for it. Here either all of it lands or none of it does.
 *
 * The callback must use the supplied `tx` for every write. Using the global `prisma`
 * client inside it would escape the transaction.
 */
export async function transact<T>(
  userId: string,
  work: (context: TransactContext) => Promise<T>,
): Promise<T> {
  return serialisePerWallet(userId, () =>
    walletTransaction(async (tx) => {
      const context: TransactContext = {
        tx,
        debit: (input) => {
          assertPositive(input.amount);
          return applyMovement(tx, { ...input, userId, signedAmount: -input.amount });
        },
        credit: (input) => {
          assertPositive(input.amount);
          return applyMovement(tx, { ...input, userId, signedAmount: input.amount });
        },
      };
      return work(context);
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export interface WalletAudit {
  balance: bigint;
  /** Sum of every ledger amount. Must equal `balance`. */
  ledgerSum: bigint;
  /** `balanceAfter` of the newest entry. Must equal `balance`. */
  latestBalanceAfter: bigint | null;
  consistent: boolean;
}

/**
 * Prove a wallet's balance is exactly what its ledger says it is.
 *
 * Used by the test suite and by the admin back office. If this ever reports
 * `consistent: false`, something has written a balance outside this service.
 */
export async function auditWallet(userId: string): Promise<WalletAudit> {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { id: true, balance: true },
  });
  if (!wallet) throw notFound("Wallet not found", "WALLET_NOT_FOUND");

  const [aggregate, latest] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { walletId: wallet.id }, _sum: { amount: true } }),
    prisma.ledgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { balanceAfter: true },
    }),
  ]);

  const ledgerSum = aggregate._sum.amount ?? 0n;
  const latestBalanceAfter = latest?.balanceAfter ?? null;

  const consistent =
    ledgerSum === wallet.balance &&
    (latestBalanceAfter === null ? wallet.balance === 0n : latestBalanceAfter === wallet.balance);

  if (!consistent) {
    logger.error(
      {
        userId,
        balance: wallet.balance.toString(),
        ledgerSum: ledgerSum.toString(),
        latestBalanceAfter: latestBalanceAfter?.toString() ?? null,
      },
      "wallet ledger inconsistency - a balance was written outside wallet.service",
    );
  }

  return { balance: wallet.balance, ledgerSum, latestBalanceAfter, consistent };
}
