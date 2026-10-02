/**
 * Every random value and every piece of encryption in the API.
 *
 * `node:crypto` only. `Math.random` is banned in this app and enforced by
 * `tests/no-math-random.test.ts` - it is predictable, and a predictable shuffle or
 * token is the whole game.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { env } from "./env.js";

/* -------------------------------- randomness ------------------------------- */

/** Uniform integer in `[0, maxExclusive)`. Rejection-sampled by node, so unbiased. */
export function secureRandomInt(maxExclusive: number): number {
  return randomInt(maxExclusive);
}

/** A url-safe random token. 32 bytes is the floor for anything auth-bearing. */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Fisher-Yates, drawing each index from `crypto.randomInt`.
 *
 * Shuffles in place and returns the same array. Iterating downward and swapping with
 * an index in `[0, i]` is the only correct form - the common "swap with any index"
 * variant does not produce a uniform permutation.
 */
export function secureShuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

/* --------------------------------- hashing --------------------------------- */

/**
 * SHA-256, hex. For *high-entropy* values only: refresh tokens, reset tokens.
 *
 * Passwords and backup codes use Argon2id instead (see `auth/password.ts`). A fast
 * hash is right here precisely because these values are long and random, so there is
 * nothing to brute force, and they are verified on every request.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, safe on strings of differing length. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/* ---------------------------- field encryption ----------------------------- */

const KEY = Buffer.from(env.FIELD_ENCRYPTION_KEY, "base64");
const IV_BYTES = 12; // 96 bits, the standard nonce size for GCM
const VERSION = "v1";

/**
 * Encrypt a value for storage with AES-256-GCM. Used for TOTP secrets, which must be
 * recoverable (we need the secret to verify a code) yet must not be readable from a
 * database dump.
 *
 * Format: `v1:<iv>:<authTag>:<ciphertext>`, all base64url. The version prefix is
 * there so the key or algorithm can be rotated without guessing at old rows.
 *
 * A fresh random IV per call is mandatory: reusing an IV under the same key destroys
 * GCM's security entirely.
 */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Reverse `encryptField`. Throws if the ciphertext was tampered with - GCM's auth tag
 * check fails, which is the point of using an AEAD mode.
 */
export function decryptField(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("encrypted field is malformed or uses an unknown version");
  }

  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
