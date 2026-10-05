import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";
import mysql from "mysql2/promise";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const firebaseUid = process.env.CONTENT_ADMIN_FIREBASE_UID?.trim();
const email = process.env.CONTENT_ADMIN_EMAIL?.trim().toLowerCase();
const encryptionKey = Buffer.from(process.env.ADMIN_TOTP_ENCRYPTION_KEY || "", "base64");
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!firebaseUid || !email || !connectionString) {
  throw new Error("Set CONTENT_ADMIN_FIREBASE_UID, CONTENT_ADMIN_EMAIL, and a database URL in .env.local");
}
if (/^(replace-with|your-|example)/i.test(firebaseUid) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /^(replace-with|your-|example)/i.test(email)) {
  throw new Error("Use the real Firebase UID and email for the intended content administrator");
}
if (encryptionKey.length !== 32) throw new Error("ADMIN_TOTP_ENCRYPTION_KEY must decode to 32 bytes");
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
if (!firebaseProjectId || firebaseProjectId !== process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
  throw new Error("Firebase server and client project IDs must both be set and match");
}

const setupSuffix = createHash("sha256").update(firebaseUid).digest("hex").slice(0, 12);
const setupTextPath = resolve(process.cwd(), `.admin-mfa-${setupSuffix}.txt`);
const setupPngPath = resolve(process.cwd(), `.admin-mfa-${setupSuffix}.png`);
if (existsSync(setupTextPath) || existsSync(setupPngPath)) {
  throw new Error("An MFA setup artifact already exists for this account; securely remove it before provisioning again");
}

const url = new URL(connectionString);
if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql protocol");
const caPath = process.env.MYSQL_SSL_CA;
const ssl = {
  rejectUnauthorized: true,
  ...(caPath ? { ca: (await import("node:fs")).readFileSync(resolve(process.cwd(), caPath)) } : {}),
};
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
  ssl,
  connectTimeout: 15000,
  multipleStatements: false,
});

let textCreated = false;
let imageCreated = false;
try {
  const [existingUid] = await connection.execute(
    "SELECT firebase_uid FROM luck_cays_admins WHERE firebase_uid = ? LIMIT 1",
    [firebaseUid],
  );
  if (existingUid.length) throw new Error("This Firebase UID already has a Luck-Cays admin record");

  const [existingEmail] = await connection.execute(
    "SELECT firebase_uid FROM luck_cays_admins WHERE LOWER(email) = ? LIMIT 1",
    [email],
  );
  if (existingEmail.length) throw new Error("This email already has a Luck-Cays admin record; do not create a duplicate");

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const encryptedSecret = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  const totp = new OTPAuth.TOTP({ issuer: "Luck-Cays", label: email, digits: 6, period: 30, secret });

  writeFileSync(setupTextPath, `Scan this setup QR with an authenticator app, then delete both setup files:\n${totp.toString()}\n`, { flag: "wx", mode: 0o600 });
  textCreated = true;
  imageCreated = true;
  await QRCode.toFile(setupPngPath, totp.toString(), { errorCorrectionLevel: "H", margin: 2, width: 480 });
  chmodSync(setupPngPath, 0o600);

  await connection.beginTransaction();
  try {
    await connection.execute(
      `INSERT INTO luck_cays_admins
       (firebase_uid, email, role, status, totp_secret_ciphertext)
       VALUES (?, ?, 'CONTENT_ADMIN', 'ACTIVE', ?)`,
      [firebaseUid, email, encryptedSecret],
    );
    await connection.execute(
      `INSERT INTO luck_cays_audit_logs (id, actor_uid, action, entity_type, entity_id)
       VALUES (?, ?, 'CONTENT_ADMIN_PROVISIONED', 'admin', ?)`,
      [randomUUID(), firebaseUid, firebaseUid],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  console.log("Content admin provisioned. Scan the private QR image, then delete both MFA setup artifacts.");
  console.log(`MFA QR: apps/web/${setupPngPath.split(/[/\\]/).pop()}`);
  console.log(`MFA text: apps/web/${setupTextPath.split(/[/\\]/).pop()}`);
} catch (error) {
  if (textCreated && existsSync(setupTextPath)) unlinkSync(setupTextPath);
  if (imageCreated && existsSync(setupPngPath)) unlinkSync(setupPngPath);
  throw error;
} finally {
  await connection.end();
}
