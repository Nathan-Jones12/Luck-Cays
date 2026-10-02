/**
 * Redis, with an in-process fallback so the prototype runs with no infrastructure.
 *
 * The PRD uses Redis for rate limits, poker table state and token revocation. All
 * three are *shared* state, so the fallback is explicitly single-process only: with
 * two API instances, rate limits would be counted twice over and a poker table could
 * exist twice. `env.ts` refuses an empty REDIS_URL in production for that reason.
 *
 * Only the small surface the app actually uses is implemented, rather than pretending
 * to be Redis. If a feature needs a command that is not here, add it to both
 * implementations so the fallback cannot silently diverge.
 */
import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` of 0 means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increment and return the new value, setting a TTL on first increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** Acquire a lock; returns false if someone already holds it. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  /** The underlying ioredis client, for libraries that need one. Null on fallback. */
  readonly client: Redis | null;
}

class RedisStore implements KeyValueStore {
  constructor(readonly client: Redis) {}

  async get(key: string) {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds = 0) {
    if (ttlSeconds > 0) await this.client.set(key, value, "EX", ttlSeconds);
    else await this.client.set(key, value);
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async incr(key: string, ttlSeconds: number) {
    const value = await this.client.incr(key);
    // Only the first increment sets the window, so the window does not slide.
    if (value === 1 && ttlSeconds > 0) await this.client.expire(key, ttlSeconds);
    return value;
  }

  async exists(key: string) {
    return (await this.client.exists(key)) === 1;
  }

  async acquireLock(key: string, ttlSeconds: number) {
    const result = await this.client.set(key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async releaseLock(key: string) {
    await this.client.del(key);
  }
}

/**
 * In-process fallback. Expiry is checked lazily on read and swept periodically, so a
 * key that is never read again still cannot leak memory forever.
 */
class MemoryStore implements KeyValueStore {
  readonly client = null;
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor() {
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt !== 0 && entry.expiresAt <= now) this.entries.delete(key);
      }
    }, 60_000);
    sweep.unref();
  }

  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string) {
    return this.read(key);
  }

  async set(key: string, value: string, ttlSeconds = 0) {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
    });
  }

  async del(key: string) {
    this.entries.delete(key);
  }

  async incr(key: string, ttlSeconds: number) {
    const current = this.read(key);
    const next = current === null ? 1 : Number(current) + 1;
    const existing = this.entries.get(key);
    this.entries.set(key, {
      value: String(next),
      // Preserve the original window rather than extending it on every hit.
      expiresAt:
        current !== null && existing
          ? existing.expiresAt
          : ttlSeconds > 0
            ? Date.now() + ttlSeconds * 1000
            : 0,
    });
    return next;
  }

  async exists(key: string) {
    return this.read(key) !== null;
  }

  async acquireLock(key: string, ttlSeconds: number) {
    if (this.read(key) !== null) return false;
    await this.set(key, "1", ttlSeconds);
    return true;
  }

  async releaseLock(key: string) {
    this.entries.delete(key);
  }
}

function create(): KeyValueStore {
  if (!env.REDIS_URL) {
    logger.warn(
      "REDIS_URL is not set - using the in-process store. Rate limits, poker state and revocations are NOT shared, so run only one API instance.",
    );
    return new MemoryStore();
  }

  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  client.on("error", (error) => logger.error({ err: error }, "redis error"));
  client.on("connect", () => logger.info("redis connected"));
  return new RedisStore(client);
}

export const store: KeyValueStore = create();

export const usingRedis = store.client !== null;

export async function disconnectRedis(): Promise<void> {
  if (store.client) await store.client.quit();
}
