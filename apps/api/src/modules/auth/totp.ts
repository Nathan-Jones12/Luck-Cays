/**
 * TOTP two-factor auth. Optional for players, mandatory for admins.
 *
 * The shared secret has to be recoverable to verify a code, so it cannot be hashed -
 * it is encrypted at the field level with AES-256-GCM instead (see `lib/crypto.ts`), so
 * a leaked database dump does not hand over everyone's second factor.
 */
import { authenticator } from "otplib";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { decryptField, encryptField, secureRandomInt } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";
import { hashBackupCode, verifyBackupCode } from "./password.js";

/**
 * One step either side of the current window, to tolerate clock drift between the
 * server and the user's phone. Wider than that starts to meaningfully extend the
 * window in which a shoulder-surfed code still works.
 */
authenticator.options = { window: 1 };

const ISSUER = "Luck-Cays";

export interface TotpEnrolment {
  /** Show once, for manual entry. */
  secret: string;
  /** `otpauth://` URI for the QR code. */
  uri: string;
}

export function generateTotpSecret(accountName: string): TotpEnrolment {
  const secret = authenticator.generateSecret();
  return { secret, uri: authenticator.keyuri(accountName, ISSUER, secret) };
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

export function encryptTotpSecret(secret: string): string {
  return encryptField(secret);
}

export function decryptTotpSecret(encrypted: string): string {
  return decryptField(encrypted);
}

/* ------------------------------- backup codes ------------------------------ */

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5;
/** Crockford-style alphabet: no I, L, O, U, so codes cannot be misread aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateBackupCode(): string {
  let code = "";
  for (let i = 0; i < BACKUP_CODE_BYTES * 2; i++) {
    code += ALPHABET[secureRandomInt(ALPHABET.length)];
  }
  // Grouped for legibility; `normaliseBackupCode` strips the dash before comparing.
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Replace a user's backup codes and return the plaintext set. This is the only moment
 * the codes exist in readable form - they are stored Argon2id hashed.
 */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  const hashes = await Promise.all(codes.map(hashBackupCode));

  await prisma.$transaction([
    prisma.backupCode.deleteMany({ where: { userId } }),
    prisma.backupCode.createMany({
      data: hashes.map((codeHash) => ({ userId, codeHash })),
    }),
  ]);

  return codes;
}

/**
 * Consume a backup code. Single use: a matching code is marked used before this
 * returns, so the same code cannot be replayed.
 */
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const candidates = await prisma.backupCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });

  for (const candidate of candidates) {
    if (await verifyBackupCode(candidate.codeHash, code)) {
      // Guard on `usedAt` still being null so two concurrent attempts with the same
      // code cannot both succeed.
      const { count } = await prisma.backupCode.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      return count === 1;
    }
  }

  return false;
}

export async function countUnusedBackupCodes(userId: string): Promise<number> {
  return prisma.backupCode.count({ where: { userId, usedAt: null } });
}

/* --------------------------------- gating ---------------------------------- */

/**
 * Check the second factor during login. Accepts a TOTP code or a backup code; demands
 * one or the other when the account has 2FA enabled.
 */
export async function assertSecondFactor(
  user: { id: string; totpEnabled: boolean; totpSecretEnc: string | null },
  provided: { totp?: string; backupCode?: string },
): Promise<void> {
  if (!user.totpEnabled) return;

  if (provided.totp) {
    if (!user.totpSecretEnc) {
      throw badRequest("TOTP_NOT_CONFIGURED", "Two-factor authentication is not set up correctly");
    }
    if (!verifyTotpCode(decryptTotpSecret(user.totpSecretEnc), provided.totp)) {
      throw unauthorized("Invalid authentication code", "TOTP_INVALID");
    }
    return;
  }

  if (provided.backupCode) {
    if (!(await consumeBackupCode(user.id, provided.backupCode))) {
      throw unauthorized("Invalid backup code", "BACKUP_CODE_INVALID");
    }
    return;
  }

  throw unauthorized("Authentication code required", "TOTP_REQUIRED");
}
