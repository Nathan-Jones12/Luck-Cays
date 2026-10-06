/**
 * The free-spin grant over HTTP.
 *
 * The service tests prove the grant behaves correctly. These prove it cannot be reached by
 * anyone who should not reach it, which is the part that would actually hurt: a granted spin
 * pays at its locked bet without taking a stake, so this endpoint mints expected value.
 *
 * Role is read from the database on every request rather than from the token, so these tests
 * sign one token per account and change the row - which is also how a revoked admin loses
 * access immediately.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { slotGames } from "@luck-cays/shared";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { signAccessToken, signGameToken } from "../src/modules/auth/tokens.js";
import { makePlayer, resetDatabase } from "./helpers/db.js";

const app = createApp();
const GAME = "wild-harbour";
const ROUTE = "/api/admin/slots/free-spins";

function configOf(slug: string) {
  const config = slotGames.get(slug);
  if (!config) throw new Error(`no config for ${slug}`);
  return config;
}

const lowBet = () => String(Math.min(...configOf(GAME).betLevels));

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

/** A valid body, so a rejection can only be about who is asking. */
function validBody(userId: string): Record<string, unknown> {
  return {
    userId,
    gameSlug: GAME,
    spins: 10,
    bet: lowBet(),
    reason: "Demonstrating the free-spin feature",
  };
}

beforeEach(async () => {
  await resetDatabase();
  await seedGames();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("who may grant free spins", () => {
  it("lets an admin grant them", async () => {
    const admin = await makePlayer(0n, "admin");
    const target = await makePlayer(0n);
    const token = await signAccessToken(admin.userId, "admin");

    const response = await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${token}`)
      .send(validBody(target.userId));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      gameSlug: GAME,
      remaining: 10,
      bet: lowBet(),
      multiplier: configOf(GAME).scatter.freeSpinMultiplier,
    });

    const session = await prisma.slotFreeSpinSession.findFirstOrThrow({
      where: { userId: target.userId },
      select: { remaining: true },
    });
    expect(session.remaining).toBe(10);
  });

  it("refuses a player, who could otherwise grant themselves value", async () => {
    const player = await makePlayer(0n);
    const token = await signAccessToken(player.userId, "player");

    const response = await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${token}`)
      .send(validBody(player.userId));

    expect(response.status).toBe(403);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  /** Support can read the back office but must not be able to hand out value. */
  it("refuses support", async () => {
    const support = await makePlayer(0n, "support");
    const target = await makePlayer(0n);
    const token = await signAccessToken(support.userId, "support");

    const response = await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${token}`)
      .send(validBody(target.userId));

    expect(response.status).toBe(403);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  it("refuses an unauthenticated request", async () => {
    const target = await makePlayer(0n);

    const response = await request(app).post(ROUTE).send(validBody(target.userId));

    expect(response.status).toBe(401);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  /**
   * The one that matters most. A game session runs inside an iframe on embedded pages, so if
   * it could reach staff routes the whole embedding design would be unsound.
   */
  it("refuses a game session token, even one minted for an admin's account", async () => {
    const admin = await makePlayer(0n, "admin");
    const gameToken = await signGameToken(admin.userId, GAME, "luck-cays");

    const response = await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${gameToken}`)
      .send(validBody(admin.userId));

    expect(response.status).toBe(401);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  it("refuses an admin whose role has since been revoked", async () => {
    const admin = await makePlayer(0n, "admin");
    const target = await makePlayer(0n);
    const token = await signAccessToken(admin.userId, "admin");

    // The token still says admin. The database does not, and the database wins.
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "player" } });

    const response = await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${token}`)
      .send(validBody(target.userId));

    expect(response.status).toBe(403);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });
});

describe("what the endpoint accepts", () => {
  async function asAdmin(body: Record<string, unknown>) {
    const admin = await makePlayer(0n, "admin");
    const token = await signAccessToken(admin.userId, "admin");
    return request(app).post(ROUTE).set("Authorization", `Bearer ${token}`).send(body);
  }

  it("requires a reason, so the audit entry is never empty", async () => {
    const target = await makePlayer(0n);
    const response = await asAdmin({ ...validBody(target.userId), reason: "x" });

    expect(response.status).toBe(400);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  it("rejects a bet the game does not offer", async () => {
    const target = await makePlayer(0n);
    const response = await asAdmin({ ...validBody(target.userId), bet: "999999" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_BET");
    // The allowed levels come back, so the UI can show what it should have sent.
    expect(response.body.error.details.allowed).toEqual(configOf(GAME).betLevels);
  });

  it("caps how many spins one call can grant", async () => {
    const target = await makePlayer(0n);
    const response = await asAdmin({ ...validBody(target.userId), spins: 10_000 });

    expect(response.status).toBe(400);
    expect(await prisma.slotFreeSpinSession.count()).toBe(0);
  });

  it("rejects a fractional spin count", async () => {
    const target = await makePlayer(0n);
    const response = await asAdmin({ ...validBody(target.userId), spins: 2.5 });

    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown player", async () => {
    const response = await asAdmin(validBody("not-a-real-user-id"));

    expect(response.status).toBe(404);
  });
});

describe("the audit trail", () => {
  it("records the grant with its reason and who made it", async () => {
    const admin = await makePlayer(0n, "admin");
    const target = await makePlayer(0n);
    const token = await signAccessToken(admin.userId, "admin");

    await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validBody(target.userId), spins: 7, reason: "Checking the bonus animation" })
      .expect(200);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.grant_free_spins" },
    });

    expect(entry.actorId).toBe(admin.userId);
    expect(entry.targetId).toBe(target.userId);
    expect(entry.targetType).toBe("user");

    const details = JSON.parse(entry.detailsJson ?? "{}") as Record<string, unknown>;
    expect(details).toMatchObject({
      gameSlug: GAME,
      spins: 7,
      bet: lowBet(),
      reason: "Checking the bonus animation",
    });
  });

  it("writes nothing when the grant is refused", async () => {
    const player = await makePlayer(0n);
    const token = await signAccessToken(player.userId, "player");

    await request(app)
      .post(ROUTE)
      .set("Authorization", `Bearer ${token}`)
      .send(validBody(player.userId))
      .expect(403);

    expect(await prisma.auditLog.count({ where: { action: "admin.grant_free_spins" } })).toBe(0);
  });
});

describe("the game list the grant form reads", () => {
  it("carries each game bet levels and bonus multiplier", async () => {
    const admin = await makePlayer(0n, "admin");
    const token = await signAccessToken(admin.userId, "admin");

    const response = await request(app)
      .get("/api/admin/slots")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const game = (response.body.games as Array<Record<string, unknown>>).find(
      (row) => row.slug === GAME,
    );

    // The form offers only these as bets, so if they stop arriving it silently offers none.
    expect(game?.betLevels).toEqual(configOf(GAME).betLevels);
    expect(game?.freeSpinMultiplier).toBe(configOf(GAME).scatter.freeSpinMultiplier);
  });
});
