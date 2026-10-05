/**
 * Test environment. Runs before any test module is imported, so `lib/env.ts` sees these values
 * rather than the developer's .env.
 *
 * SQLite by default, with its own database file: a test run truncates every table, and doing that
 * to someone's dev data would be unforgivable.
 *
 * An externally set DATABASE_PROVIDER is respected, which is how CI runs the same suite against
 * MySQL. That matters: on MySQL the wallet takes a real `SELECT ... FOR UPDATE`, and the
 * concurrency guarantee for the path that actually ships is only proven there.
 */
import { randomBytes } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

// Default to a dedicated SQLite file; leave an explicitly configured provider alone.
process.env.DATABASE_PROVIDER ??= "sqlite";
if (process.env.DATABASE_PROVIDER === "sqlite") {
  process.env.DATABASE_URL = "file:./test.db";
} else if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_PROVIDER is set to mysql but DATABASE_URL is missing");
}

process.env.JWT_SECRET ??= randomBytes(48).toString("base64");
process.env.FIELD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

process.env.WEB_ORIGIN ??= "http://localhost:5173";
process.env.GAME_ORIGIN ??= "http://localhost:5173";
process.env.EMBED_ORIGINS ??= "http://localhost:4173";

process.env.SIGNUP_BONUS_CHIPS = "10000";
process.env.DAILY_BONUS_CHIPS = "2500";
