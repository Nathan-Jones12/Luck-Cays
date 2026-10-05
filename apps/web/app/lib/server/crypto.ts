import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";

function encryptionKey(): Buffer {
  const value = process.env.ADMIN_TOTP_ENCRYPTION_KEY;
  if (!value) throw new Error("ADMIN_TOTP_ENCRYPTION_KEY is not configured");

  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("ADMIN_TOTP_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export function encryptTotpSecret(secret: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptTotpSecret(value: Buffer): string {
  if (value.length < 30 || value[0] !== 1) throw new Error("Invalid encrypted MFA secret");
  const iv = value.subarray(1, 13);
  const tag = value.subarray(13, 29);
  const ciphertext = value.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function createTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function createTotpUri(email: string, secret: string): string {
  return new OTPAuth.TOTP({
    issuer: "Luck-Cays",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).toString();
}

export function acceptedTotpCounter(email: string, secret: string, token: string): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const totp = new OTPAuth.TOTP({
    issuer: "Luck-Cays",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1 });
  return delta === null ? null : totp.counter() + delta;
}

export function createOpaqueSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createId(): string {
  return randomUUID();
}
