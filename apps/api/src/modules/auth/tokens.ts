/**
 * Access and refresh tokens.
 *
 * Access tokens are short-lived JWTs the client holds in memory only. Refresh tokens
 * are opaque random strings in an httpOnly cookie, stored hashed, and rotated on every
 * use.
 *
 * Rotation with reuse detection is the point. Every token from one login shares a
 * `familyId`. Presenting a token that has already been rotated means either a replay
 * or a stolen cookie, and we cannot tell which - so the entire family is revoked and
 * both the thief and the legitimate user are logged out. That is the correct trade:
 * a forced re-login beats a silent persistent session for an attacker.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Role } from "@luck-cays/shared";
import { env } from "../../lib/env.js";
import { hashToken, secureToken } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { unauthorized } from "../../lib/errors.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = "luck-cays";
const AUDIENCE = "luck-cays-web";

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: Role;
}

/** Seconds until an access token expires, derived from the configured TTL. */
export function accessTokenTtlSeconds(): number {
  const match = /^(\d+)([smhd])$/.exec(env.ACCESS_TOKEN_TTL);
  if (!match)
    throw new Error(`ACCESS_TOKEN_TTL must look like "15m", got "${env.ACCESS_TOKEN_TTL}"`);

  const amount = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d";
  const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
  return amount * multiplier;
}

export async function signAccessToken(userId: string, role: Role): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(secret);
}

/**
 * Verify an access token. Issuer and audience are checked as well as the signature, so
 * a token minted for something else cannot be replayed here.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== "string" || typeof payload.role !== "string") {
      throw unauthorized("Malformed token", "TOKEN_INVALID");
    }
    return payload as AccessTokenClaims;
  } catch (error) {
    if (error instanceof Error && error.name === "JWTExpired") {
      throw unauthorized("Access token expired", "TOKEN_EXPIRED");
    }
    throw unauthorized("Invalid access token", "TOKEN_INVALID");
  }
}

/* ------------------------------ refresh tokens ----------------------------- */

export const REFRESH_COOKIE = "lc_refresh";

export interface IssuedRefreshToken {
  /** The raw token. Goes in the cookie and is never stored. */
  token: string;
  expiresAt: Date;
  familyId: string;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

/** Start a new token family. One per login. */
export async function issueRefreshToken(userId: string): Promise<IssuedRefreshToken> {
  const token = secureToken(32);
  const familyId = secureToken(16);
  const expiresAt = refreshExpiry();

  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(token), familyId, expiresAt },
  });

  return { token, expiresAt, familyId };
}

export interface RotationResult {
  userId: string;
  role: Role;
  refresh: IssuedRefreshToken;
}

/**
 * Exchange a refresh token for a new one.
 *
 * Four rejections, all deliberately reported as the same opaque failure so a caller
 * cannot probe which tokens exist: unknown token, expired token, already-rotated token
 * (which also burns the family), and a user who is no longer active.
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotationResult> {
  const tokenHash = hashToken(rawToken);

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      familyId: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: { role: true, status: true } },
    },
  });

  if (!existing) throw unauthorized("Session expired", "REFRESH_INVALID");

  // Reuse of a rotated or revoked token: assume theft and burn the whole family.
  if (existing.revokedAt !== null) {
    await revokeFamily(existing.familyId);
    logger.warn(
      { userId: existing.userId, familyId: existing.familyId },
      "refresh token reuse detected - family revoked",
    );
    throw unauthorized("Session expired", "REFRESH_REUSED");
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("Session expired", "REFRESH_EXPIRED");
  }

  if (existing.user.status !== "active") {
    await revokeFamily(existing.familyId);
    throw unauthorized("Session expired", "ACCOUNT_NOT_ACTIVE");
  }

  const token = secureToken(32);
  const expiresAt = refreshExpiry();

  // Mark the old token spent and mint its replacement in one transaction, so a crash
  // cannot leave two live tokens in the family.
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashToken(token),
        familyId: existing.familyId,
        expiresAt,
      },
    }),
  ]);

  return {
    userId: existing.userId,
    role: existing.user.role as Role,
    refresh: { token, expiresAt, familyId: existing.familyId },
  };
}

export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Log out one session. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { familyId: true },
  });
  // Revoke the family, not just this token: a logout should end the session, and any
  // sibling token would otherwise keep it alive.
  if (existing) await revokeFamily(existing.familyId);
}

/** Log out everywhere. Used on password change and by admin actions. */
export async function revokeAllForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Housekeeping: drop tokens that expired long enough ago to be of no interest. */
export async function pruneExpiredTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const { count } = await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return count;
}
