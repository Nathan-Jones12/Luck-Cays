/**
 * The wallet: the only code that changes `wallets.balance` or writes `ledger_entries`.
 * Everything else that moves chips calls in here.
 *
 * Every change happens inside the caller's transaction, with the wallet row locked
 * (SELECT ... FOR UPDATE), and appends a ledger entry whose `balance_after` matches the new
 * balance. Ledger rows are never updated or deleted.
 *
 * Lock order: lock the wallet before any other row for the same user (e.g. vip_progress),
 * everywhere, so two transactions can never deadlock waiting on each other.
 */
import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

export interface CreditInput {
  userId: string;
  /** Whole chips, > 0. */
  amount: bigint;
  /** A ledgerTypeSchema value from src/shared/schemas/common.ts, e.g. "vip_reward". */
  type: string;
  refType?: string;
  refId?: string;
  /** Replaying the same key returns without moving chips a second time. */
  idempotencyKey: string;
}

export interface WalletRow {
  id: string;
  balance: bigint;
}

/** Locks and returns the user's wallet, or null if they have none. Call inside a transaction. */
export async function lockWallet(conn: PoolConnection, userId: string): Promise<WalletRow | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE",
    [userId],
  );
  const row = rows[0];
  return row ? { id: row.id as string, balance: BigInt(row.balance as string) } : null;
}

/**
 * Adds chips to a wallet. Must run inside a transaction on `conn`; the caller commits.
 * Returns the new balance, or null if this idempotency key was already applied.
 */
export async function credit(conn: PoolConnection, input: CreditInput): Promise<bigint | null> {
  if (input.amount <= 0n) throw new Error(`credit amount must be positive, got ${input.amount}`);

  const wallet = await lockWallet(conn, input.userId);
  if (!wallet) throw new Error(`user ${input.userId} has no wallet`);

  // Checked after taking the lock, so two concurrent replays cannot both pass.
  const [existing] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM ledger_entries WHERE idempotency_key = ?",
    [input.idempotencyKey],
  );
  if (existing.length > 0) return null;

  const balanceAfter = wallet.balance + input.amount;
  await conn.query("UPDATE wallets SET balance = ? WHERE id = ?", [
    balanceAfter.toString(),
    wallet.id,
  ]);
  await conn.query(
    `INSERT INTO ledger_entries
       (id, wallet_id, amount, type, ref_type, ref_id, idempotency_key, balance_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      wallet.id,
      input.amount.toString(),
      input.type,
      input.refType ?? null,
      input.refId ?? null,
      input.idempotencyKey,
      balanceAfter.toString(),
    ],
  );
  return balanceAfter;
}
