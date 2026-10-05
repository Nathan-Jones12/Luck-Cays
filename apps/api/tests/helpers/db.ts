/**
 * Per-test database helpers.
 *
 * `resetDatabase` clears every table in dependency order rather than relying on
 * cascades, so a test starts genuinely empty. `makePlayer` creates a user and wallet
 * directly, bypassing signup, because most tests are not about signup.
 */
import { prisma } from "../../src/lib/prisma.js";

/** Child tables first; parents last. */
const TABLES_IN_DELETE_ORDER = [
  "poker_actions",
  "poker_hands",
  "poker_seats",
  "poker_tables",
  "sports_bets",
  "sports_markets",
  "sports_events",
  "slot_free_spin_sessions",
  "slot_rounds",
  "slot_games",
  "vip_progress",
  "vip_tiers",
  "bonus_claims",
  "ledger_entries",
  "wallets",
  "backup_codes",
  "auth_tokens",
  "game_launch_tokens",
  "refresh_tokens",
  "audit_log",
  "users",
  "config_values",
] as const;

export async function resetDatabase(): Promise<void> {
  for (const table of TABLES_IN_DELETE_ORDER) {
    // Raw DELETE because Prisma has no "clear every model" API. The table names are
    // from the constant list above, never from user input.
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
}

let counter = 0;

export interface TestPlayer {
  userId: string;
  walletId: string;
  email: string;
  username: string;
}

/** Create a player with a wallet at `startingBalance` chips. */
export async function makePlayer(startingBalance = 0n, role = "player"): Promise<TestPlayer> {
  counter += 1;
  const email = `player${counter}@example.test`;
  const username = `player${counter}`;

  const user = await prisma.user.create({
    data: {
      email,
      username,
      // Not a real hash: no test here verifies a password against this value.
      passwordHash: "test-not-a-real-hash",
      role,
      emailVerifiedAt: new Date(),
      adultConfirmedAt: new Date(),
    },
    select: { id: true },
  });

  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balance: 0n },
    select: { id: true },
  });

  // Fund through the ledger, not by setting the balance, so the wallet starts
  // internally consistent and `auditWallet` passes on it.
  if (startingBalance > 0n) {
    await prisma.$transaction([
      prisma.wallet.update({ where: { id: wallet.id }, data: { balance: startingBalance } }),
      prisma.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          amount: startingBalance,
          type: "bonus",
          refType: "test_fixture",
          balanceAfter: startingBalance,
        },
      }),
    ]);
  }

  return { userId: user.id, walletId: wallet.id, email, username };
}
