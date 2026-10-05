/**
 * The embedding boundary.
 *
 * These are security tests more than feature tests. The whole design rests on four claims,
 * and each one is only true if it is enforced:
 *
 *   1. A launch ticket works once.
 *   2. A launch ticket expires quickly.
 *   3. A game session can play only the game it was minted for.
 *   4. A game session is not an account - it cannot reach player or staff routes.
 *
 * Claim 4 is the one that would hurt most if it were wrong, because the game runs in an
 * iframe on pages we embed into.
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { hashToken } from "../src/lib/crypto.js";
import { createLaunch, exchangeLaunch } from "../src/modules/launch/launch.service.js";
import {
  signAccessToken,
  signGameToken,
  verifyAccessToken,
  verifyGameToken,
} from "../src/modules/auth/tokens.js";
import { makePlayer, resetDatabase } from "./helpers/db.js";
import { slotGames } from "@luck-cays/shared";

const GAME = "reef-riches";
const OTHER_GAME = "krakens-depths";

/** The launch service checks the game exists and is active, so the suite needs them seeded. */
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

/** The raw token out of a launch URL, which is what the game would redeem. */
function ticketToken(launchUrl: string): string {
  const token = new URL(launchUrl).searchParams.get("token");
  if (!token) throw new Error("launch URL carried no token");
  return token;
}

beforeEach(async () => {
  await resetDatabase();
  await seedGames();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("minting a launch ticket", () => {
  it("returns a URL carrying a token for the requested game", async () => {
    const player = await makePlayer(10_000n);
    const ticket = await createLaunch({ userId: player.userId, gameSlug: GAME, brand: "reef" });

    const url = new URL(ticket.launchUrl);
    expect(url.pathname).toBe("/game.html");
    expect(url.searchParams.get("game")).toBe(GAME);
    expect(url.searchParams.get("brand")).toBe("reef");
    expect(ticketToken(ticket.launchUrl).length).toBeGreaterThan(20);
    expect(ticket.expiresIn).toBeLessThanOrEqual(120);
  });

  it("stores only a hash of the token, never the token", async () => {
    const player = await makePlayer(10_000n);
    const ticket = await createLaunch({
      userId: player.userId,
      gameSlug: GAME,
      brand: "luck-cays",
    });
    const token = ticketToken(ticket.launchUrl);

    const rows = await prisma.gameLaunchToken.findMany({ select: { tokenHash: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(token));
    // The readable token must appear nowhere in the row.
    expect(rows[0]?.tokenHash).not.toBe(token);
  });

  it("refuses an unknown game", async () => {
    const player = await makePlayer(10_000n);
    await expect(
      createLaunch({ userId: player.userId, gameSlug: "no-such-game", brand: "luck-cays" }),
    ).rejects.toMatchObject({ code: "GAME_NOT_FOUND" });
  });

  it("refuses a game that is not active", async () => {
    const player = await makePlayer(10_000n);
    await prisma.slotGame.update({ where: { slug: GAME }, data: { isActive: false } });

    await expect(
      createLaunch({ userId: player.userId, gameSlug: GAME, brand: "luck-cays" }),
    ).rejects.toMatchObject({ code: "GAME_INACTIVE" });
  });

  it("refuses an origin that is not one of ours", async () => {
    const player = await makePlayer(10_000n);
    await expect(
      createLaunch({
        userId: player.userId,
        gameSlug: GAME,
        brand: "luck-cays",
        origin: "https://not-our-site.example",
      }),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("refuses a return URL that is not one of ours", async () => {
    const player = await makePlayer(10_000n);
    await expect(
      createLaunch({
        userId: player.userId,
        gameSlug: GAME,
        brand: "luck-cays",
        returnUrl: "https://not-our-site.example/thanks",
      }),
    ).rejects.toMatchObject({ code: "RETURN_URL_NOT_ALLOWED" });
  });
});

describe("redeeming a launch ticket", () => {
  it("returns a game-scoped session and the current balance", async () => {
    const player = await makePlayer(7_500n);
    const ticket = await createLaunch({ userId: player.userId, gameSlug: GAME, brand: "temple" });

    const session = await exchangeLaunch(ticketToken(ticket.launchUrl), undefined);

    expect(session.gameSlug).toBe(GAME);
    expect(session.brand).toBe("temple");
    expect(session.balance).toBe("7500");
    expect(session.player.username).toBe(player.username);
    expect(session.sessionToken.length).toBeGreaterThan(20);
  });

  /** Claim 1. A ticket in a log or a browser history must be inert. */
  it("works exactly once", async () => {
    const player = await makePlayer(1_000n);
    const ticket = await createLaunch({
      userId: player.userId,
      gameSlug: GAME,
      brand: "luck-cays",
    });
    const token = ticketToken(ticket.launchUrl);

    await expect(exchangeLaunch(token, undefined)).resolves.toMatchObject({ gameSlug: GAME });
    await expect(exchangeLaunch(token, undefined)).rejects.toMatchObject({
      code: "LAUNCH_INVALID",
    });
  });

  it("cannot be redeemed twice even concurrently", async () => {
    const player = await makePlayer(1_000n);
    const ticket = await createLaunch({
      userId: player.userId,
      gameSlug: GAME,
      brand: "luck-cays",
    });
    const token = ticketToken(ticket.launchUrl);

    const results = await Promise.allSettled([
      exchangeLaunch(token, undefined),
      exchangeLaunch(token, undefined),
      exchangeLaunch(token, undefined),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });

  /** Claim 2. */
  it("refuses an expired ticket", async () => {
    const player = await makePlayer(1_000n);
    const ticket = await createLaunch({
      userId: player.userId,
      gameSlug: GAME,
      brand: "luck-cays",
    });
    const token = ticketToken(ticket.launchUrl);

    await prisma.gameLaunchToken.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(exchangeLaunch(token, undefined)).rejects.toMatchObject({
      code: "LAUNCH_INVALID",
    });
  });

  it("refuses an unknown ticket", async () => {
    await expect(
      exchangeLaunch("not-a-real-token-but-long-enough", undefined),
    ).rejects.toMatchObject({ code: "LAUNCH_INVALID" });
  });

  it("refuses a ticket redeemed from a different origin than it was pinned to", async () => {
    const player = await makePlayer(1_000n);
    const ticket = await createLaunch({
      userId: player.userId,
      gameSlug: GAME,
      brand: "luck-cays",
      // WEB_ORIGIN, which the allowlist permits.
      origin: "http://localhost:5173",
    });

    await expect(
      exchangeLaunch(ticketToken(ticket.launchUrl), "http://localhost:9999"),
    ).rejects.toMatchObject({ code: "LAUNCH_INVALID" });
  });

  it("refuses a player who has been banned since the ticket was minted", async () => {
    const player = await makePlayer(1_000n);
    const ticket = await createLaunch({
      userId: player.userId,
      gameSlug: GAME,
      brand: "luck-cays",
    });

    await prisma.user.update({ where: { id: player.userId }, data: { status: "banned" } });

    await expect(exchangeLaunch(ticketToken(ticket.launchUrl), undefined)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_ACTIVE",
    });
  });
});

describe("game session scope", () => {
  /** Claim 3. The slug lives in the token, not just the URL, so it cannot be swapped. */
  it("carries the game it was minted for", async () => {
    const player = await makePlayer(1_000n);
    const token = await signGameToken(player.userId, GAME, "luck-cays");

    const claims = await verifyGameToken(token);
    expect(claims.sub).toBe(player.userId);
    expect(claims.gameSlug).toBe(GAME);
    expect(claims.gameSlug).not.toBe(OTHER_GAME);
  });

  /**
   * Claim 4, and the important one. The two token kinds use different JWT audiences, so
   * neither verifier accepts the other's token. That is enforced by the library rather than
   * by remembering to check a claim at each call site.
   */
  it("is not accepted as a player access token", async () => {
    const player = await makePlayer(1_000n);
    const gameToken = await signGameToken(player.userId, GAME, "luck-cays");

    await expect(verifyAccessToken(gameToken)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("does not accept a player access token as a game session", async () => {
    const player = await makePlayer(1_000n);
    const accessToken = await signAccessToken(player.userId, "player");

    await expect(verifyGameToken(accessToken)).rejects.toMatchObject({
      code: "GAME_SESSION_INVALID",
    });
  });

  it("carries no role, so it cannot satisfy a staff gate", async () => {
    const admin = await makePlayer(1_000n, "admin");
    const gameToken = await signGameToken(admin.userId, GAME, "luck-cays");

    const claims = await verifyGameToken(gameToken);
    // Even for an admin's account, the game session has no role claim at all.
    expect(claims["role"]).toBeUndefined();
  });
});
