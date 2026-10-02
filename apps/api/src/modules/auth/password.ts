/**
 * Password and backup-code hashing.
 *
 * Argon2id, per the PRD. Argon2id is the hybrid variant: it resists GPU cracking like
 * Argon2d and side-channel attacks like Argon2i, and it is what OWASP recommends for
 * password storage.
 *
 * A fast hash (SHA-256) is right for high-entropy tokens and wrong here. Passwords are
 * low entropy and guessable, so the hash has to be deliberately expensive.
 */
import argon2 from "argon2";
import { badRequest } from "../../lib/errors.js";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/**
 * OWASP's recommended Argon2id floor: 19 MiB of memory, 2 iterations, 1 degree of
 * parallelism. Memory cost is what actually hurts an attacker with GPUs.
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored hash, so
 * a corrupted row cannot be told apart from a wrong password by timing or response.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

const MIN_LENGTH = 10;

/**
 * The server-side password policy. The client checks length for a quick message; this
 * is the authority, and it also rejects the passwords everyone actually picks.
 *
 * Deliberately no composition rules (one upper, one digit, one symbol). They push
 * people toward `Password1!` while banning genuinely strong passphrases, and both
 * NIST SP 800-63B and OWASP now advise against them. Length plus a blocklist is the
 * better trade.
 */
export function assertPasswordAllowed(
  password: string,
  context: { email: string; username: string },
): void {
  if (password.length < MIN_LENGTH) {
    throw badRequest("WEAK_PASSWORD", `Password must be at least ${MIN_LENGTH} characters`);
  }

  const normalised = password.trim().toLowerCase();

  if (COMMON_PASSWORDS.has(normalised)) {
    throw badRequest("WEAK_PASSWORD", "That password is too common. Please choose another.");
  }

  // A password that is just the account's own identifiers is trivially guessable.
  const localPart = context.email.split("@")[0]?.toLowerCase() ?? "";
  if (normalised === context.email.toLowerCase() || normalised === context.username.toLowerCase()) {
    throw badRequest("WEAK_PASSWORD", "Password must not be your email or username");
  }
  if (localPart.length >= 4 && normalised.includes(localPart)) {
    throw badRequest("WEAK_PASSWORD", "Password must not contain your email address");
  }
  if (normalised.includes("luckcays") || normalised.includes("luck-cays")) {
    throw badRequest("WEAK_PASSWORD", "Password must not contain the site name");
  }

  // A single repeated character reaches 10 characters without any real entropy.
  if (new Set(normalised).size <= 3) {
    throw badRequest("WEAK_PASSWORD", "Password must use more than a few distinct characters");
  }
}

/* ------------------------------- backup codes ------------------------------ */

/**
 * Backup codes are hashed with Argon2id too, not SHA-256. They are short enough to be
 * typed by a human, which makes them short enough to brute force if the hash is fast.
 */
export async function hashBackupCode(code: string): Promise<string> {
  return argon2.hash(normaliseBackupCode(code), OPTIONS);
}

export async function verifyBackupCode(hash: string, code: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, normaliseBackupCode(code));
  } catch {
    return false;
  }
}

/** Codes are shown grouped and case-insensitive; compare them the same way. */
export function normaliseBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
