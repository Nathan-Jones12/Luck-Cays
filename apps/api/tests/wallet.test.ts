/**
 * The wallet's four guarantees. These are the PRD's phase-one exit check.
 *
 * Note what the concurrency tests can and cannot prove here. On SQLite the wallet
 * serialises debits with an in-process mutex, so these tests prove that mutex works.
 * The MySQL path uses `SELECT ... FOR UPDATE` instead, and proving *that* needs a
 * MySQL instance - `docker compose up -d mysql`, then DATABASE_PROVIDER=mysql. The
 * logic under test is identical either way; only the lock differs.
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  auditWallet,
  credit,
  debit,
  getBalance,
  getLedger,
  transact,
} from "../src/modules/wallet/wallet.service.js";
import { AppError } from "../src/lib/errors.js";
import { makePlayer, resetDatabase } from "./helpers/db.js";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const key = (name: string) => `test-${name}-${Math.random().toString(36).slice(2, 10)}`;

describe("whole chips", () => {
  it("keeps exact values far beyond what a float could hold", async () => {
    // 2^53 + 1 is the first integer a double cannot represent. A Number-based wallet
    // would silently round this and the test would fail.
    const huge = 9_007_199_254_740_993n;
    const player = await makePlayer(huge);

    expect(await getBalance(player.userId)).toBe(huge);

    await debit({ userId: player.userId, amount: 1n, type: "bet", idempotencyKey: key("huge") });
    expect(await getBalance(player.userId)).toBe(huge - 1n);
  });

  it("rejects a zero or negative amount", async () => {
    const player = await makePlayer(1_000n);

    await expect(debit({ userId: player.userId, amount: 0n, type: "bet" })).rejects.toThrow(
      /greater than zero/,
    );
    await expect(credit({ userId: player.userId, amount: -5n, type: "win" })).rejects.toThrow(
      /greater than zero/,
    );
  });
});

describe("never negative", () => {
  it("rejects a debit larger than the balance and leaves the balance untouched", async () => {
    const player = await makePlayer(100n);

    await expect(
      debit({ userId: player.userId, amount: 101n, type: "bet", idempotencyKey: key("over") }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });

    expect(await getBalance(player.userId)).toBe(100n);

    // The rejected debit must not have written a ledger row.
    const ledger = await getLedger(player.userId, { limit: 50 });
    expect(ledger.entries.filter((e) => e.type === "bet")).toHaveLength(0);
  });

  it("allows a debit of the exact balance", async () => {
    const player = await makePlayer(100n);

    const result = await debit({
      userId: player.userId,
      amount: 100n,
      type: "bet",
      idempotencyKey: key("exact"),
    });

    expect(result.balance).toBe(0n);
    expect(await getBalance(player.userId)).toBe(0n);
  });

  /**
   * The oversell test. Twenty concurrent debits of 10 against a balance of 100: only
   * ten can succeed. Without a lock, several would read the same balance, all pass the
   * check, and the balance would end up negative.
   */
  it("cannot be oversold by concurrent debits", async () => {
    const player = await makePlayer(100n);

    const attempts = Array.from({ length: 20 }, (_, i) =>
      debit({
        userId: player.userId,
        amount: 10n,
        type: "bet",
        idempotencyKey: key(`race-${i}`),
      }),
    );

    const results = await Promise.allSettled(attempts);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(10);
    expect(failed).toHaveLength(10);
    for (const failure of failed) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect((failure as PromiseRejectedResult).reason.code).toBe("INSUFFICIENT_FUNDS");
    }

    expect(await getBalance(player.userId)).toBe(0n);
    expect((await auditWallet(player.userId)).consistent).toBe(true);
  });

  it("stays consistent under interleaved debits and credits", async () => {
    const player = await makePlayer(1_000n);

    const operations = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? debit({
            userId: player.userId,
            amount: 25n,
            type: "bet",
            idempotencyKey: key(`m-d-${i}`),
          })
        : credit({
            userId: player.userId,
            amount: 25n,
            type: "win",
            idempotencyKey: key(`m-c-${i}`),
          }),
    );

    await Promise.allSettled(operations);

    // 30 debits and 30 credits of equal size, all affordable, so we end where we began.
    expect(await getBalance(player.userId)).toBe(1_000n);

    const audit = await auditWallet(player.userId);
    expect(audit.consistent).toBe(true);
    expect(audit.ledgerSum).toBe(1_000n);
  });
});

describe("append-only ledger", () => {
  it("records balanceAfter on every entry and never rewrites one", async () => {
    const player = await makePlayer(500n);

    await debit({ userId: player.userId, amount: 200n, type: "bet", idempotencyKey: key("l1") });
    await credit({ userId: player.userId, amount: 50n, type: "win", idempotencyKey: key("l2") });
    await debit({ userId: player.userId, amount: 100n, type: "bet", idempotencyKey: key("l3") });

    const ledger = await getLedger(player.userId, { limit: 50 });
    // Newest first: -100, +50, -200, then the fixture's +500.
    expect(ledger.entries.map((e) => e.amount)).toEqual([-100n, 50n, -200n, 500n]);
    expect(ledger.entries.map((e) => e.balanceAfter)).toEqual([250n, 350n, 300n, 500n]);

    const audit = await auditWallet(player.userId);
    expect(audit.balance).toBe(250n);
    expect(audit.ledgerSum).toBe(250n);
    expect(audit.latestBalanceAfter).toBe(250n);
    expect(audit.consistent).toBe(true);
  });

  it("paginates by cursor without repeating or skipping entries", async () => {
    const player = await makePlayer(10_000n);

    for (let i = 0; i < 12; i++) {
      await debit({
        userId: player.userId,
        amount: 10n,
        type: "bet",
        idempotencyKey: key(`p${i}`),
      });
    }

    const first = await getLedger(player.userId, { limit: 5 });
    expect(first.entries).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();

    const second = await getLedger(player.userId, {
      limit: 5,
      cursor: first.nextCursor as string,
    });
    expect(second.entries).toHaveLength(5);

    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(10);
  });

  it("filters by entry type", async () => {
    const player = await makePlayer(1_000n);
    await debit({ userId: player.userId, amount: 100n, type: "bet", idempotencyKey: key("f1") });
    await credit({ userId: player.userId, amount: 300n, type: "win", idempotencyKey: key("f2") });

    const wins = await getLedger(player.userId, { limit: 50, type: "win" });
    expect(wins.entries).toHaveLength(1);
    expect(wins.entries[0]?.amount).toBe(300n);
  });
});

describe("idempotency", () => {
  it("moves chips once however many times a key is replayed", async () => {
    const player = await makePlayer(1_000n);
    const idempotencyKey = key("replay");

    const first = await debit({ userId: player.userId, amount: 250n, type: "bet", idempotencyKey });
    expect(first.replayed).toBe(false);

    for (let i = 0; i < 4; i++) {
      const again = await debit({
        userId: player.userId,
        amount: 250n,
        type: "bet",
        idempotencyKey,
      });
      expect(again.replayed).toBe(true);
      expect(again.ledgerEntryId).toBe(first.ledgerEntryId);
      expect(again.balance).toBe(first.balance);
    }

    expect(await getBalance(player.userId)).toBe(750n);
    const ledger = await getLedger(player.userId, { limit: 50, type: "bet" });
    expect(ledger.entries).toHaveLength(1);
  });

  it("charges once when the same key arrives concurrently", async () => {
    const player = await makePlayer(1_000n);
    const idempotencyKey = key("concurrent-replay");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        debit({ userId: player.userId, amount: 100n, type: "bet", idempotencyKey }),
      ),
    );

    // Every call must succeed - a retry is not an error - but only one may move chips.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await getBalance(player.userId)).toBe(900n);

    const ledger = await getLedger(player.userId, { limit: 50, type: "bet" });
    expect(ledger.entries).toHaveLength(1);
  });

  it("rejects a key reused for a different amount", async () => {
    const player = await makePlayer(1_000n);
    const idempotencyKey = key("mismatch");

    await debit({ userId: player.userId, amount: 100n, type: "bet", idempotencyKey });

    await expect(
      debit({ userId: player.userId, amount: 200n, type: "bet", idempotencyKey }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    expect(await getBalance(player.userId)).toBe(900n);
  });
});

describe("transact", () => {
  it("commits the movements and the caller's own writes together", async () => {
    const player = await makePlayer(1_000n);

    const outcome = await transact(player.userId, async ({ tx, debit: take, credit: give }) => {
      await take({ amount: 100n, type: "bet", idempotencyKey: key("t-bet") });

      const game = await tx.slotGame.create({
        data: {
          slug: `probe-${Math.random().toString(36).slice(2, 8)}`,
          name: "Probe",
          configJson: "{}",
          rtpTargetBp: 9600,
          isActive: false,
        },
        select: { id: true },
      });

      const round = await tx.slotRound.create({
        data: {
          userId: player.userId,
          gameId: game.id,
          bet: 100n,
          win: 250n,
          stopsJson: "[]",
        },
        select: { id: true },
      });

      const after = await give({
        amount: 250n,
        type: "win",
        refType: "slot_round",
        refId: round.id,
        idempotencyKey: key("t-win"),
      });

      return { roundId: round.id, balance: after.balance };
    });

    expect(outcome.balance).toBe(1_150n);
    expect(await getBalance(player.userId)).toBe(1_150n);
    expect(await prisma.slotRound.count({ where: { id: outcome.roundId } })).toBe(1);
    expect((await auditWallet(player.userId)).consistent).toBe(true);
  });

  it("rolls back the chips when the caller's own write fails", async () => {
    const player = await makePlayer(1_000n);

    await expect(
      transact(player.userId, async ({ tx, debit: take }) => {
        await take({ amount: 400n, type: "bet", idempotencyKey: key("rollback") });

        // A round pointing at a game that does not exist: the foreign key fails and
        // takes the whole transaction with it, bet included.
        await tx.slotRound.create({
          data: {
            userId: player.userId,
            gameId: "game-that-does-not-exist",
            bet: 400n,
            win: 0n,
            stopsJson: "[]",
          },
        });
      }),
    ).rejects.toThrow();

    expect(await getBalance(player.userId)).toBe(1_000n);

    const ledger = await getLedger(player.userId, { limit: 50, type: "bet" });
    expect(ledger.entries).toHaveLength(0);
    expect((await auditWallet(player.userId)).consistent).toBe(true);
  });

  it("rolls back when a debit inside the transaction is unaffordable", async () => {
    const player = await makePlayer(100n);

    await expect(
      transact(player.userId, async ({ credit: give, debit: take }) => {
        await give({ amount: 50n, type: "bonus", idempotencyKey: key("tb-credit") });
        // 150 available at this point, so 500 must still fail and undo the credit.
        await take({ amount: 500n, type: "bet", idempotencyKey: key("tb-debit") });
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });

    expect(await getBalance(player.userId)).toBe(100n);
    expect((await auditWallet(player.userId)).consistent).toBe(true);
  });
});

describe("isolation between wallets", () => {
  it("does not let one player's debits affect another's balance", async () => {
    const [a, b] = await Promise.all([makePlayer(500n), makePlayer(500n)]);

    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        debit({ userId: a.userId, amount: 50n, type: "bet", idempotencyKey: key(`a${i}`) }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        debit({ userId: b.userId, amount: 10n, type: "bet", idempotencyKey: key(`b${i}`) }),
      ),
    ]);

    expect(await getBalance(a.userId)).toBe(0n);
    expect(await getBalance(b.userId)).toBe(450n);
  });
});
