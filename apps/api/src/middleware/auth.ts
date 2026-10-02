/**
 * Authentication and role gates.
 *
 * `requireAuth` establishes who the caller is; `requireRole` decides what they may do.
 * Both are route middleware - no service reads the request object, so every service is
 * testable without one.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@luck-cays/shared";
import { forbidden, unauthorized } from "../lib/errors.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { prisma } from "../lib/prisma.js";

export interface AuthContext {
  userId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Absent on public routes. */
      auth?: AuthContext;
    }
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Require a valid access token.
 *
 * The token's claims are trusted for identity, but the account's *status* is read from
 * the database on every request. A 15-minute token must not keep a banned or
 * self-excluded player playing for another 15 minutes.
 */
export const requireAuth: RequestHandler = async (request, _response, next) => {
  try {
    const token = bearerToken(request);
    if (!token) throw unauthorized();

    const claims = await verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, status: true },
    });
    if (!user) throw unauthorized("Account not found", "USER_NOT_FOUND");

    if (user.status === "banned") throw forbidden("This account is suspended", "ACCOUNT_BANNED");
    if (user.status === "self_excluded") {
      throw forbidden("This account is self-excluded", "ACCOUNT_SELF_EXCLUDED");
    }

    // Role comes from the database too, so a revoked admin loses access immediately
    // rather than when their token expires.
    request.auth = { userId: user.id, role: user.role as Role };
    next();
  } catch (error) {
    next(error);
  }
};

/** Identify the caller if a token is present, but let anonymous requests through. */
export const optionalAuth: RequestHandler = async (request, _response, next) => {
  const token = bearerToken(request);
  if (!token) return next();

  try {
    const claims = await verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, status: true },
    });
    if (user && user.status === "active") {
      request.auth = { userId: user.id, role: user.role as Role };
    }
  } catch {
    // An invalid token on an optional route is simply an anonymous request.
  }
  next();
};

/**
 * Restrict a route to the listed roles. `admin` is NOT implicitly granted every
 * permission - list it explicitly, so a route's access is readable where it is defined.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.auth) return next(unauthorized());
    if (!roles.includes(request.auth.role)) {
      return next(forbidden("You do not have permission to do that"));
    }
    next();
  };
}

/** The authenticated context, or a 401. Saves every route re-checking. */
export function authOf(request: Request): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
