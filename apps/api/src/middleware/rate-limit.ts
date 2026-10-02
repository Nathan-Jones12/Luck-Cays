/**
 * Rate limits.
 *
 * Backed by Redis when one is configured, so limits hold across API instances. With the
 * in-process fallback each instance counts separately - fine for the prototype, which is
 * why `env.ts` requires REDIS_URL in production.
 *
 * Login is limited twice over: per IP, which slows a spray across many accounts, and per
 * email, which slows a spray against one account. Neither alone is enough.
 */
import rateLimit, { type Options, type Store } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import type { Request } from "express";
import { env } from "../lib/env.js";
import { store as kv } from "../lib/redis.js";
import { AppError } from "../lib/errors.js";

function makeStore(prefix: string): Store | undefined {
  const client = kv.client;
  if (!client) return undefined;

  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // rate-limit-redis issues raw commands so it works with any client. ioredis's
    // `call` is overloaded, and the (command, argsArray) form is the one a variadic
    // list maps onto cleanly - spreading into it does not typecheck.
    sendCommand: async (...args: string[]) => {
      const [command = "PING", ...rest] = args;
      return (await client.call(command, rest)) as number | string;
    },
  });
}

/** Trust the proxy's forwarded IP only when we are actually behind one. */
function clientIp(request: Request): string {
  return (env.TRUST_PROXY ? request.ip : request.socket.remoteAddress) ?? "unknown";
}

function build(name: string, options: Partial<Options>) {
  return rateLimit({
    windowMs: 60_000,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Go through the app's error channel so the body shape matches every other error.
    handler: (_request, _response, next) => {
      next(new AppError(429, "RATE_LIMITED", "Too many requests. Please slow down."));
    },
    ...(makeStore(name) ? { store: makeStore(name) } : {}),
    ...options,
  });
}

/** Everything, as a blanket backstop. */
export const globalLimiter = build("global", {
  windowMs: 60_000,
  limit: 600,
  keyGenerator: clientIp,
});

/** Login and signup, per IP. */
export const authIpLimiter = build("auth-ip", {
  windowMs: 15 * 60_000,
  limit: 30,
  keyGenerator: clientIp,
});

/**
 * Login per account. Keyed on the submitted email, so one account cannot be sprayed from
 * a botnet of addresses. Successful logins do not count against it.
 */
export const authAccountLimiter = build("auth-account", {
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (request: Request) => {
    const email = (request.body as { email?: unknown } | undefined)?.email;
    return typeof email === "string" ? `email:${email.toLowerCase()}` : `ip:${clientIp(request)}`;
  },
});

/** Password reset requests, which send mail and so cost real money. */
export const passwordResetLimiter = build("password-reset", {
  windowMs: 60 * 60_000,
  limit: 5,
  keyGenerator: clientIp,
});

/**
 * Gameplay. Generous, because a fast autoplay session is legitimate; this exists to stop
 * a script hammering the spin endpoint, not to pace a player.
 */
export const gameplayLimiter = build("gameplay", {
  windowMs: 60_000,
  limit: 300,
  keyGenerator: (request: Request) => request.auth?.userId ?? clientIp(request),
});

/** Bet placement, where each request moves chips. */
export const betLimiter = build("bet", {
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (request: Request) => request.auth?.userId ?? clientIp(request),
});
