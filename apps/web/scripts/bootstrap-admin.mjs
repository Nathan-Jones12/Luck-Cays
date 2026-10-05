import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";
import mysql from "mysql2/promise";
import * as OTPAuth from "otpauth";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const uid = process.env.BOOTSTRAP_ADMIN_FIREBASE_UID;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const encryptionKey = Buffer.from(process.env.ADMIN_TOTP_ENCRYPTION_KEY || "", "base64");
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const setupFile = resolve(process.cwd(), ".admin-mfa-setup.txt");
if (!uid || !email || !connectionString) throw new Error("Set BOOTSTRAP_ADMIN_FIREBASE_UID, BOOTSTRAP_ADMIN_EMAIL, and a database URL in .env.local");
if (existsSync(setupFile)) throw new Error("Move or securely delete the existing .admin-mfa-setup.txt before bootstrapping");
if (encryptionKey.length !== 32) throw new Error("ADMIN_TOTP_ENCRYPTION_KEY must decode to 32 bytes");
const firebaseSettings = [
  process.env.FIREBASE_PROJECT_ID,
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
];
if (firebaseSettings.some((value) => !value || /^(replace-with|your-|example|luck-cays-firebase-project-id)/i.test(value))) {
  throw new Error("Set all Firebase project and Web app settings in .env.local before bootstrapping");
}
if (process.env.FIREBASE_PROJECT_ID !== process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
  throw new Error("FIREBASE_PROJECT_ID and NEXT_PUBLIC_FIREBASE_PROJECT_ID must match");
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /^(replace-with|your-|example|admin@example\.com)/i.test(email)) {
  throw new Error("BOOTSTRAP_ADMIN_EMAIL must be the verified Firebase user's real email address");
}
if (/^(replace-with|your-|example)/i.test(uid)) {
  throw new Error("BOOTSTRAP_ADMIN_FIREBASE_UID must be the real Firebase user's UID");
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

let setupFileWritten = false;
try {
  const [existing] = await connection.execute("SELECT firebase_uid FROM luck_cays_admins WHERE firebase_uid = ? LIMIT 1", [uid]);
  if (existing.length) throw new Error("This Firebase UID is already registered as a Luck-Cays admin");
  const [superAdmins] = await connection.execute("SELECT firebase_uid FROM luck_cays_admins WHERE role = 'SUPER_ADMIN' LIMIT 1");
  if (superAdmins.length) throw new Error("A SUPER_ADMIN already exists; bootstrap is one-time only");

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const encryptedSecret = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  const totp = new OTPAuth.TOTP({ issuer: "Luck-Cays", label: email, digits: 6, period: 30, secret });
  writeFileSync(setupFile, `Scan this URI with an authenticator app, then delete this file:\n${totp.toString()}\n`, { mode: 0o600, flag: "wx" });
  setupFileWritten = true;

  await connection.beginTransaction();
  try {
    await connection.execute(
      `INSERT INTO luck_cays_admins
       (firebase_uid, email, role, status, totp_secret_ciphertext)
       VALUES (?, ?, 'SUPER_ADMIN', 'ACTIVE', ?)`,
      [uid, email, encryptedSecret],
    );
    await connection.execute(
      `INSERT INTO luck_cays_audit_logs (id, actor_uid, action, entity_type, entity_id)
       VALUES (?, ?, 'ADMIN_BOOTSTRAPPED', 'admin', ?)`,
      [randomUUID(), uid, uid],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
  console.log("Bootstrap admin created. MFA enrollment URI written to .admin-mfa-setup.txt; keep it private and delete it after enrollment.");
} catch (error) {
  if (setupFileWritten && existsSync(setupFile)) unlinkSync(setupFile);
  throw error;
} finally {
  await connection.end();
}
