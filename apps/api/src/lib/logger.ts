/**
 * Logging. Secrets are redacted by path, not by hoping nobody logs them.
 *
 * The redaction list is deliberately broad: it is cheaper to redact a field that
 * was never sensitive than to discover a password in a log aggregator.
 */
import pino from "pino";
import { env, isProduction, isTest } from "./env.js";

export const logger = pino({
  level: isTest ? "silent" : isProduction ? "info" : "debug",

  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "password",
      "newPassword",
      "passwordHash",
      "token",
      "accessToken",
      "refreshToken",
      "tokenHash",
      "totp",
      "totpSecret",
      "totpSecretEnc",
      "backupCode",
      "backupCodes",
      // Hole cards and decks must never reach a log - a leaked log would be a
      // leaked hand.
      "holeCards",
      "deck",
      "*.password",
      "*.token",
      "*.holeCards",
      "*.deck",
    ],
    censor: "[redacted]",
  },

  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});

logger.debug(
  { provider: env.DATABASE_PROVIDER, redis: env.REDIS_URL ? "external" : "in-process" },
  "logger ready",
);
