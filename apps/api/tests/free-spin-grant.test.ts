/**
 * The free-spin grant.
 *
 * This is a staff tool that hands over real expected value - a free spin pays at its locked
 * bet without taking a stake - so the tests care about four things:
 *
 *   1. A granted spin is actually spendable by the spin service.
 *   2. The bet cannot be arbitrary, because the bet is the value.
 *   3. A grant tops up one session rather than creating a second the spin service would miss.
 *   4. It never touches the wallet directly, and never changes the game's maths.
 *
 * Claim 2 is the one that matters most: the spin service deliberately does not re-validate a
 * free spin's bet (a real bonus's bet was already validated when it triggered), so the grant
 * is the only place that check exists.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { slotGames } from "@luck-cays/shared";
import { prisma } from "../src/lib/prisma.js";
import { grantFreeSpins, spin } from "../src/modules/slots/slots.service.js";
import { auditWallet } from "../src/modules/wallet/wallet.service.js";
import { makePlayer, resetDatabase } from "./helpers/db.js";

const GAME = "wild-harbour";

async function seedGames(): Promise<void> {
  for (const config of slotGames.values()) {
    await prisma.slotGame.create({
      data: {
        slug: config.slug,
        name: config.name,
        configJson: JSON.stringify(config),
        rtpTargetBp: Math.round(config.rtpTarget * 10_000),
        isActive: true,
      },
    });
  }
}

function configOf(slug: string) {
  const config = slotGames.get(slug);
  if (!config) throw new Error(`no config for ${slug}`);
  return config;
}

/** The lowest bet the game offers, as a bigint. */
function lowestBet(slug: string): bigint {
  const levels = configOf(slug).betLevels;
  return BigInt(Math.min(...levels));
}

beforeEach(async () => {
  await resetDatabase();
  await seedGames();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("granting free spins", () => {
  it("creates a session the player can spend", async () => {
    const player = await makePlayer(0n);
    const bet = lowestBet(GAME);

    const grant = await grantFreeSpins({
      userId: player.userId,
      gameSlug: GAME,
      spins: 10,
      bet,
    });

    expect(grant.gameSlug).toBe(GAME);
    expect(grant.remaining).toBe(10);
    expect(grant.bet).toBe(bet.toString(10));
    expect(grant.multiplier).toBe(configOf(GAME).scatter.freeSpinMultiplier);
  });

  it("locks the spins to the game's own free-spin multiplier, not a chosen one", async () => {
    const player = await makePlayer(0n);

    const grant = await grantFreeSpins({
      userId: player.userId,
      gameSlug: GAME,
      spins: 5,
      bet: lowestBet(GAME),
    });

    // The caller has no say in this. It comes from the shipped config, so a granted bonus
    // behaves exactly like a triggered one.
    expect(grant.multiplier).toBe(configOf(GAME).scatter.freeSpinMultiplier);
  });

  /** Claim 2. */
  it("refuses a bet the game does not offer", async () => {
    const player = await makePlayer(0n);

    await expect(
      grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 10, bet: 999_999n }),
    ).rejects.toMatchObject({ code: "INVALID_BET" });

    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  it("refuses an unknown game", async () => {
    const player = await makePlayer(0n);

    await expect(
      grantFreeSpins({ userId: player.userId, gameSlug: "no-such-game", spins: 10, bet: 100n }),
    ).rejects.toMatchObject({ code: "GAME_NOT_FOUND" });
  });

  it("refuses an unknown player rather than failing on the foreign key", async () => {
    await expect(
      grantFreeSpins({
        userId: "not-a-real-user-id",
        gameSlug: GAME,
        spins: 10,
        bet: lowestBet(GAME),
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  /** Claim 3. The spin service reads one session; a second row would be invisible to it. */
  it("tops up the existing session instead of creating a second one", async () => {
    const player = await makePlayer(0n);
    const bet = lowestBet(GAME);

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 4, bet });
    const second = await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 6, bet });

    expect(second.remaining).toBe(10);
    expect(await prisma.slotFreeSpinSession.count()).toBe(1);
  });

  it("keeps a run in progress at the bet it was triggered at", async () => {
    const player = await makePlayer(0n);
    const levels = configOf(GAME).betLevels;
    const low = BigInt(Math.min(...levels));
    const high = BigInt(Math.max(...levels));
    expect(low).not.toBe(high);

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 3, bet: low });
    // Spins already earned are owed at their own bet, so a top-up must not reprice them.
    const topped = await grantFreeSpins({
      userId: player.userId,
      gameSlug: GAME,
      spins: 3,
      bet: high,
    });

    expect(topped.remaining).toBe(6);
    expect(topped.bet).toBe(low.toString(10));
  });

  it("sets its own bet once a previous run is spent", async () => {
    const player = await makePlayer(0n);
    const levels = configOf(GAME).betLevels;
    const low = BigInt(Math.min(...levels));
    const high = BigInt(Math.max(...levels));

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 1, bet: low });
    await prisma.slotFreeSpinSession.updateMany({
      where: { userId: player.userId },
      data: { remaining: 0 },
    });

    const regrant = await grantFreeSpins({
      userId: player.userId,
      gameSlug: GAME,
      spins: 2,
      bet: high,
    });

    expect(regrant.remaining).toBe(2);
    expect(regrant.bet).toBe(high.toString(10));
    expect(await prisma.slotFreeSpinSession.count()).toBe(1);
  });

  /** Claim 4. The grant writes no ledger row; it only makes future spins free. */
  it("moves no chips of its own", async () => {
    const player = await makePlayer(5_000n);
    const before = await prisma.ledgerEntry.count({ where: { walletId: player.walletId } });

    await grantFreeSpins({
      userId: player.userId,
      gameSlug: GAME,
      spins: 10,
      bet: lowestBet(GAME),
    });

    expect(await prisma.ledgerEntry.count({ where: { walletId: player.walletId } })).toBe(before);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: player.walletId } });
    expect(wallet.balance).toBe(5_000n);
  });
});

describe("spending a granted free spin", () => {
  /** Claim 1, and the point of the whole tool. */
  it("plays without taking a stake, from a balance of zero", async () => {
    const player = await makePlayer(0n);
    const bet = lowestBet(GAME);

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 3, bet });

    // A real spin here would be rejected for insufficient funds, which is what makes this a
    // sound test that the spin was genuinely free.
    const round = await spin({
      userId: player.userId,
      gameSlug: GAME,
      bet,
      idempotencyKey: "granted-spin-1",
    });

    expect(round.isFreeSpin).toBe(true);
    expect(round.bet).toBe("0");
    expect(round.freeSpinsRemaining).toBe(2);
  });

  it("records the round as zero turnover so the grant cannot inflate wagering", async () => {
    const player = await makePlayer(0n);
    const bet = lowestBet(GAME);

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 1, bet });
    await spin({
      userId: player.userId,
      gameSlug: GAME,
      bet,
      idempotencyKey: "granted-turnover",
    });

    const rounds = await prisma.slotRound.findMany({ select: { bet: true } });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.bet).toBe(0n);
  });

  /**
   * A grant buys exactly the spins it granted - no more, and none lost.
   *
   * This game does not retrigger, so the count is exact rather than probabilistic. That is
   * asserted first: if retrigger is ever turned on, this test should fail loudly and be
   * rewritten, not quietly start passing for the wrong reason.
   */
  it("consumes exactly one spin per spin and runs down to zero", async () => {
    expect(configOf(GAME).scatter.retrigger).toBe(false);

    const player = await makePlayer(0n);
    const bet = lowestBet(GAME);
    const granted = 5;

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: granted, bet });

    for (let i = 0; i < granted; i += 1) {
      const round = await spin({
        userId: player.userId,
        gameSlug: GAME,
        bet,
        idempotencyKey: `run-down-${i}`,
      });

      expect(round.isFreeSpin).toBe(true);
      expect(round.bet).toBe("0");
      expect(round.freeSpinsRemaining).toBe(granted - 1 - i);
    }

    const session = await prisma.slotFreeSpinSession.findFirstOrThrow({
      where: { userId: player.userId },
      select: { remaining: true },
    });
    expect(session.remaining).toBe(0);
  });

  it("pays wins at the granted bet, and leaves the wallet consistent", async () => {
    const player = await makePlayer(0n);
    const bet = lowestBet(GAME);

    await grantFreeSpins({ userId: player.userId, gameSlug: GAME, spins: 12, bet });

    let won = 0n;
    for (let i = 0; i < 12; i += 1) {
      const session = await prisma.slotFreeSpinSession.findFirst({
        where: { userId: player.userId },
        select: { remaining: true },
      });
      if (!session || session.remaining <= 0) break;

      const round = await spin({
        userId: player.userId,
        gameSlug: GAME,
        bet,
        idempotencyKey: `paid-${i}`,
      });
      won += BigInt(round.totalWin);
    }

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: player.walletId } });
    // Started at zero and never staked anything, so the balance is exactly what was won.
    expect(wallet.balance).toBe(won);

    const consistency = await auditWallet(player.userId);
    expect(consistency.consistent).toBe(true);
  });
});
