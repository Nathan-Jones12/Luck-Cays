import nextEnv from "@next/env";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "../app/lib/server/database.ts";
import { decryptTotpSecret } from "../app/lib/server/crypto.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const firebaseProjectReady = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_PROJECT_ID === process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
  process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
);
console.log(`Firebase project configuration: ${firebaseProjectReady ? "ready" : "missing or mismatched"}`);

const uid = process.env.BOOTSTRAP_ADMIN_FIREBASE_UID;
if (!uid) {
  console.log("Bootstrapped admin: cannot check (BOOTSTRAP_ADMIN_FIREBASE_UID missing)");
  process.exitCode = 1;
} else {
  let pool;
  try {
    pool = getDatabase();
    const [rows] = await pool.execute(
      `SELECT status, role, email, totp_secret_ciphertext, totp_enabled_at
       FROM luck_cays_admins
       WHERE firebase_uid = ?
       LIMIT 1`,
      [uid],
    );
    const admin = rows[0];
    console.log(`Bootstrapped admin row: ${admin ? "found" : "missing"}`);

    if (admin) {
      console.log(`Admin status: ${admin.status === "ACTIVE" ? "active" : "not active"}`);
      console.log(`Admin role: ${admin.role === "SUPER_ADMIN" || admin.role === "CONTENT_ADMIN" ? "recognized" : "unrecognized"}`);
      console.log(`Bootstrap email matches admin row: ${String(admin.email).trim().toLowerCase() === String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase() ? "yes" : "no"}`);
      const hasSecret = Buffer.isBuffer(admin.totp_secret_ciphertext) && admin.totp_secret_ciphertext.length > 0;
      console.log(`Encrypted MFA secret: ${hasSecret ? "present" : "missing"}`);
      let keyMatches = false;
      if (hasSecret) {
        try {
          decryptTotpSecret(admin.totp_secret_ciphertext);
          keyMatches = true;
        } catch {
          keyMatches = false;
        }
      }
      console.log(`TOTP encryption key matches stored secret: ${keyMatches ? "yes" : "no"}`);
      console.log(`MFA enrollment active: ${admin.totp_enabled_at ? "yes" : "not activated yet"}`);
      if (admin.status !== "ACTIVE" || !hasSecret || !keyMatches) process.exitCode = 1;

      const connection = await pool.getConnection();
      let transactionOpen = false;
      try {
        await connection.beginTransaction();
        transactionOpen = true;
        await connection.execute(
          `UPDATE luck_cays_admins
           SET totp_enabled_at = COALESCE(totp_enabled_at, UTC_TIMESTAMP(3)), last_totp_counter = ?
           WHERE firebase_uid = ? AND status = 'ACTIVE'`,
          [1, uid],
        );
        const sessionId = randomUUID();
        await connection.execute(
          `INSERT INTO luck_cays_admin_sessions (id, firebase_uid, session_token_hash, expires_at)
           VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 900 SECOND))`,
          [sessionId, uid, createHash("sha256").update(randomBytes(32)).digest()],
        );
        await connection.execute(
          `INSERT INTO luck_cays_audit_logs (id, actor_uid, action, entity_type, entity_id)
           VALUES (?, ?, 'ADMIN_LOGIN', 'admin_session', ?)`,
          [randomUUID(), uid, sessionId],
        );
        await connection.rollback();
        transactionOpen = false;
        console.log("Session and audit transaction probe: passed (rolled back; no rows persisted)");
      } catch (error) {
        if (transactionOpen) await connection.rollback();
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "TRANSACTION_PROBE_FAILED";
        console.log(`Session and audit transaction probe: failed (${code}; rolled back)`);
        process.exitCode = 1;
      } finally {
        connection.release();
      }
    } else {
      process.exitCode = 1;
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "DATABASE_CHECK_FAILED";
    console.log(`Read-only admin check: failed (${code})`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
