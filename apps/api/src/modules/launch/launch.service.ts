/**
 * Game launch: minting one-shot tickets and redeeming them for game sessions.
 *
 * This is the whole embedding boundary. A host page asks for a ticket, drops it in an iframe
 * URL, and the game redeems it once. The host never holds a credential that could do anything
 * else, and the session the game ends up with can only spin the one game it was minted for.
 *
 * Why a ticket rather than just putting the access token in the URL: URLs leak. They go into
 * browser history, proxy logs, `Referer` headers and screenshots. A ticket that is single-use
 * and lives for a minute is worthless by the time it surfaces anywhere.
 */
import type { Brand, GameSession, LaunchTicket } from "@luck-cays/shared";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { hashToken, secureToken } from "../../lib/crypto.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { gameSessionTtlSeconds, signGameToken } from "../auth/tokens.js";
import { getBalance } from "../wallet/wallet.service.js";

/**
 * Sixty seconds. Long enough for a page to render an iframe on a slow connection, short
 * enough that a ticket found in a log is already dead.
 */
const TICKET_TTL_SECONDS = 60;

/**
 * Origins allowed to embed a game.
 *
 * Our own front-ends only, which is the point of this build. `WEB_ORIGIN` is always allowed;
 * `EMBED_ORIGINS` adds the other brands. An empty list in development means "no origin
 * pinning", which `assertOriginAllowed` warns about rather than silently permitting.
 */
function allowedOrigins(): string[] {
  const extra = env.EMBED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [env.WEB_ORIGIN, ...extra];
}

function assertOriginAllowed(origin: string | undefined): string | null {
  if (!origin) return null;

  const permitted = allowedOrigins();
  if (!permitted.includes(origin)) {
    throw forbidden(`That origin is not allowed to embed games: ${origin}`, "ORIGIN_NOT_ALLOWED");
  }
  return origin;
}

/**
 * Which client page serves a given game.
 *
 * Most games share one client: `game.html` reads the game's config and renders it with the
 * PixiJS reel renderer, so a new strip-based theme needs no new page at all.
 *
 * "242 Wild Harbour" is the exception. It arrived as a complete, self-contained build with its
 * own art, layout and animation, and it uses weighted reels plus a coin feature the shared
 * renderer does not draw. Rebuilding that in PixiJS would have thrown away working work to no
 * benefit, so it keeps its own page - made server-authoritative against our API - and this map
 * is how a launch finds it.
 *
 * A deployment concern rather than a game-design one, which is why it lives here and not in the
 * slot config.
 */
const GAME_CLIENTS: Record<string, string> = {
  "wild-harbour": "/games/wild-harbour/index.html",
};

const DEFAULT_CLIENT = "/game.html";

function clientPathFor(slug: string): string {
  return GAME_CLIENTS[slug] ?? DEFAULT_CLIENT;
}

export interface CreateLaunchRequest {
  userId: string;
  gameSlug: string;
  brand: Brand;
  origin?: string;
  returnUrl?: string;
}

/**
 * Mint a launch ticket.
 *
 * The game must exist and be active before a ticket is handed out, so a bad slug fails here
 * rather than inside the iframe where the player would just see a broken frame.
 */
export async function createLaunch(request: CreateLaunchRequest): Promise<LaunchTicket> {
  const game = await prisma.slotGame.findUnique({
    where: { slug: request.gameSlug },
    select: { slug: true, isActive: true },
  });
  if (!game) throw notFound("No such game", "GAME_NOT_FOUND");
  if (!game.isActive) throw conflict("GAME_INACTIVE", "This game is not available to play");

  const origin = assertOriginAllowed(request.origin);

  if (request.returnUrl) {
    // A return URL becomes a link the player clicks, so it has to be one of ours.
    const returnOrigin = new URL(request.returnUrl).origin;
    if (!allowedOrigins().includes(returnOrigin)) {
      throw badRequest("RETURN_URL_NOT_ALLOWED", "That return URL is not on an allowed origin");
    }
  }

  const token = secureToken(32);

  await prisma.gameLaunchToken.create({
    data: {
      userId: request.userId,
      tokenHash: hashToken(token),
      gameSlug: game.slug,
      brand: request.brand,
      allowedOrigin: origin,
      expiresAt: new Date(Date.now() + TICKET_TTL_SECONDS * 1_000),
    },
  });

  const launchUrl = new URL(clientPathFor(game.slug), env.GAME_ORIGIN);
  launchUrl.searchParams.set("token", token);
  // Slug and brand are in the URL purely so the shell can paint the right colours before it
  // has redeemed anything. They are never trusted - the ticket is the authority.
  launchUrl.searchParams.set("game", game.slug);
  launchUrl.searchParams.set("brand", request.brand);
  if (request.returnUrl) launchUrl.searchParams.set("returnUrl", request.returnUrl);

  logger.debug({ userId: request.userId, gameSlug: game.slug }, "launch ticket minted");

  return {
    launchUrl: launchUrl.toString(),
    expiresIn: TICKET_TTL_SECONDS,
    gameSlug: game.slug,
    brand: request.brand,
  };
}

/**
 * Redeem a ticket for a game session.
 *
 * Single use, enforced with a guarded update rather than a read-then-write, so two frames
 * racing on the same ticket cannot both get a session.
 */
export async function exchangeLaunch(
  token: string,
  requestOrigin: string | undefined,
): Promise<GameSession> {
  const row = await prisma.gameLaunchToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      gameSlug: true,
      brand: true,
      allowedOrigin: true,
      expiresAt: true,
      usedAt: true,
      user: { select: { username: true, status: true } },
    },
  });

  // One opaque failure for every reason, so a caller cannot probe which tickets exist.
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("That launch link is no longer valid", "LAUNCH_INVALID");
  }

  // A ticket pinned to an origin may only be redeemed from it. This is what stops a copied
  // URL working from somewhere else within its lifetime.
  if (row.allowedOrigin && requestOrigin && row.allowedOrigin !== requestOrigin) {
    logger.warn(
      { expected: row.allowedOrigin, actual: requestOrigin },
      "launch ticket redeemed from an unexpected origin",
    );
    throw unauthorized("That launch link is no longer valid", "LAUNCH_INVALID");
  }

  if (row.user.status !== "active") {
    throw forbidden("This account cannot play", "ACCOUNT_NOT_ACTIVE");
  }

  const { count } = await prisma.gameLaunchToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count !== 1) {
    throw unauthorized("That launch link is no longer valid", "LAUNCH_INVALID");
  }

  const [sessionToken, balance] = await Promise.all([
    signGameToken(row.userId, row.gameSlug, row.brand),
    getBalance(row.userId),
  ]);

  logger.debug({ userId: row.userId, gameSlug: row.gameSlug }, "launch ticket redeemed");

  return {
    sessionToken,
    expiresIn: gameSessionTtlSeconds(),
    gameSlug: row.gameSlug,
    brand: row.brand as Brand,
    player: { username: row.user.username },
    balance: balance.toString(10),
    returnUrl: null,
  };
}

/** Housekeeping: drop tickets that expired long enough ago to be of no interest. */
export async function pruneExpiredLaunchTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 86_400_000);
  const { count } = await prisma.gameLaunchToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return count;
}
