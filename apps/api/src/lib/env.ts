/**
 * Environment, parsed and validated once at startup.
 *
 * A misconfigured secret is a security bug, so this fails loudly on boot rather
 * than letting the server run with a weak key. Nothing else in the codebase reads
 * `process.env` directly.
 */
import { z } from "zod";

/** 32 bytes, base64. Used for AES-256-GCM field encryption. */
const base64Key32 = z.string().refine((value) => {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be exactly 32 bytes of base64");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_PROVIDER: z.enum(["sqlite", "mysql"]).default("sqlite"),
    DATABASE_URL: z.string().min(1),

    /** Blank means "use the in-process fallback" - see lib/redis.ts. */
    REDIS_URL: z.string().default(""),

    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL: z.string().default("15m"),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

    FIELD_ENCRYPTION_KEY: base64Key32,

    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),

    /**
     * Where the embeddable game bundle is served from. A separate origin in production so an
     * XSS in a host page cannot reach the game's session, and vice versa. In development it
     * is the same Vite server, which loses that isolation but keeps the setup to one command.
     */
    GAME_ORIGIN: z.string().url().default("http://localhost:5173"),

    /**
     * Additional origins allowed to embed a game and to be used as a return URL, comma
     * separated. WEB_ORIGIN is always allowed. This is an allowlist of OUR front-ends - it is
     * not a way to let a third party embed games, which would need the operator wallet work.
     */
    EMBED_ORIGINS: z.string().default(""),
    TRUST_PROXY: z
      .string()
      .default("false")
      .transform((v) => v === "true"),

    SIGNUP_BONUS_CHIPS: z.coerce.number().int().nonnegative().default(10_000),
    DAILY_BONUS_CHIPS: z.coerce.number().int().nonnegative().default(2_500),

    SPORTS_API_KEY: z.string().default(""),
    SPORTS_API_BASE: z.string().default("https://api.the-odds-api.com/v4"),
    SPORTS_SYNC_CRON: z.string().default("*/15 * * * *"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;

    // The committed example values must never reach production.
    if (env.JWT_SECRET.startsWith("dev-only")) {
      ctx.addIssue({ code: "custom", message: "JWT_SECRET is still the development placeholder" });
    }
    if (env.FIELD_ENCRYPTION_KEY.startsWith("ZGV2LW9ubHk")) {
      ctx.addIssue({
        code: "custom",
        message: "FIELD_ENCRYPTION_KEY is still the development placeholder",
      });
    }
    if (env.DATABASE_PROVIDER === "sqlite") {
      ctx.addIssue({
        code: "custom",
        message:
          "DATABASE_PROVIDER=sqlite is a prototype convenience and is not safe in production: the wallet's debit lock is in-process only, so two API instances could oversell a balance. Use mysql.",
      });
    }
    if (env.REDIS_URL === "") {
      ctx.addIssue({
        code: "custom",
        message:
          "REDIS_URL is required in production: rate limits and poker state must be shared across instances.",
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** True when the wallet must fall back to an in-process lock. */
export const usesSqlite = env.DATABASE_PROVIDER === "sqlite";
