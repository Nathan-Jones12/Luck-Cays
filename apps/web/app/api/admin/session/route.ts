import { NextResponse, type NextRequest } from "next/server";
import type { RowDataPacket } from "mysql2";
import { acceptedTotpCounter, createId, createOpaqueSessionToken, decryptTotpSecret, hashSessionToken } from "@/app/lib/server/crypto";
import { recordAdminAudit } from "@/app/lib/server/admin-audit";
import { findActiveAdmin, getRecentVerifiedIdentity, type AdminIdentityRecord } from "@/app/lib/server/admin-identity";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_SECONDS, getAdminActor, isSameOrigin } from "@/app/lib/server/admin-session";
import { getDatabase } from "@/app/lib/server/database";

export const runtime = "nodejs";

type FailureCountRow = RowDataPacket & { failure_count: number };

function unauthorized(message = "Admin authentication failed", status = 401) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminActor(request);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "UNKNOWN_ERROR";
    console.error(`[admin-session] load current admin session failed (${code})`);
    return unauthorized("Admin service unavailable", 503);
  }
  if (!admin) return unauthorized("Admin session required");
  return NextResponse.json({ admin });
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return unauthorized("Request origin rejected", 403);

  let body: { idToken?: unknown; totpCode?: unknown };
  try {
    body = await request.json();
  } catch {
    return unauthorized("Invalid request", 400);
  }
  if (typeof body.idToken !== "string" || body.idToken.length > 8192) return unauthorized("Invalid request", 400);

  let identity;
  try {
    identity = await getRecentVerifiedIdentity(body.idToken);
  } catch {
    return unauthorized();
  }

  let admin;
  try {
    admin = await findActiveAdmin(identity.uid);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "UNKNOWN_ERROR";
    console.error(`[admin-session] find active admin failed (${code})`);
    return unauthorized("Admin service unavailable", 503);
  }
  if (!admin) return unauthorized("This Firebase UID is not provisioned in the Luck-Cays admin allowlist. Check that the bootstrap UID belongs to this Firebase account.", 403);
  if (identity.email.trim().toLowerCase() !== admin.email.trim().toLowerCase()) return unauthorized("This verified Firebase email does not match the email on the Luck-Cays admin record. Reconcile the admin record before signing in.", 403);
  if (!admin.totp_secret_ciphertext) return unauthorized("Admin MFA is not provisioned", 403);
  if (typeof body.totpCode !== "string") return unauthorized("Authenticator code required", 401);

  let connection;
  let stage = "acquire database connection";
  try {
    connection = await getDatabase().getConnection();
    stage = "begin transaction";
    await connection.beginTransaction();
    stage = "lock admin record";
    const [lockedAdmins] = await connection.execute<AdminIdentityRecord[]>(
      `SELECT firebase_uid, email, role, status, totp_secret_ciphertext,
              totp_enabled_at, last_totp_counter
       FROM luck_cays_admins
       WHERE firebase_uid = ? AND status = 'ACTIVE'
       LIMIT 1 FOR UPDATE`,
      [identity.uid],
    );
    const lockedAdmin = lockedAdmins[0];
    if (!lockedAdmin || !lockedAdmin.totp_secret_ciphertext) {
      await connection.commit();
      return unauthorized("Admin access is not enabled for this account", 403);
    }

    stage = "check MFA failure limit";
    const [failures] = await connection.execute<FailureCountRow[]>(
      `SELECT COUNT(*) AS failure_count
       FROM luck_cays_security_events
       WHERE firebase_uid = ?
         AND event_type = 'ADMIN_MFA_FAILURE'
         AND created_at >= UTC_TIMESTAMP(3) - INTERVAL 15 MINUTE`,
      [identity.uid],
    );
    if (Number(failures[0]?.failure_count ?? 0) >= 5) {
      await connection.commit();
      return unauthorized("Too many failed codes. Try again later.", 429);
    }

    stage = "decrypt MFA secret";
    const secret = decryptTotpSecret(lockedAdmin.totp_secret_ciphertext);
    stage = "validate authenticator code";
    const counter = acceptedTotpCounter(lockedAdmin.email, secret, body.totpCode);
    const previousCounter = lockedAdmin.last_totp_counter === null ? null : BigInt(lockedAdmin.last_totp_counter);
    if (counter === null || (previousCounter !== null && BigInt(counter) <= previousCounter)) {
      stage = "record failed MFA attempt";
      await connection.execute(
        `INSERT INTO luck_cays_security_events (id, firebase_uid, event_type)
         VALUES (?, ?, 'ADMIN_MFA_FAILURE')`,
        [createId(), identity.uid],
      );
      await connection.commit();
      return unauthorized();
    }

    const token = createOpaqueSessionToken();
    const sessionId = createId();
    stage = "update MFA counter";
    await connection.execute(
      `UPDATE luck_cays_admins
       SET totp_enabled_at = COALESCE(totp_enabled_at, UTC_TIMESTAMP(3)), last_totp_counter = ?
       WHERE firebase_uid = ? AND status = 'ACTIVE'`,
      [counter, identity.uid],
    );
    stage = "insert admin session";
    await connection.execute(
      `INSERT INTO luck_cays_admin_sessions (id, firebase_uid, session_token_hash, expires_at)
      VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${ADMIN_SESSION_TTL_SECONDS} SECOND))`,
          [sessionId, identity.uid, hashSessionToken(token)],
    );
    stage = "write admin login audit";
    await recordAdminAudit(connection, identity.uid, "ADMIN_LOGIN", "admin_session", sessionId);
    stage = "commit admin session";
    await connection.commit();

    const response = NextResponse.json({
      admin: { firebaseUid: identity.uid, email: lockedAdmin.email, role: lockedAdmin.role },
    });
    response.cookies.set(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/admin",
      maxAge: ADMIN_SESSION_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    await connection?.rollback().catch(() => undefined);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "UNKNOWN_ERROR";
    console.error(`[admin-session] ${stage} failed (${code})`);
    return unauthorized("Admin service unavailable", 503);
  } finally {
    connection?.release();
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) return unauthorized("Request origin rejected", 403);
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (token) {
    try {
      const connection = await getDatabase().getConnection();
      try {
        await connection.beginTransaction();
        const [sessions] = await connection.execute<RowDataPacket[]>(
          `SELECT firebase_uid, id
           FROM luck_cays_admin_sessions
           WHERE session_token_hash = ? AND revoked_at IS NULL
           LIMIT 1 FOR UPDATE`,
          [hashSessionToken(token)],
        );
        await connection.execute(
          `UPDATE luck_cays_admin_sessions
           SET revoked_at = UTC_TIMESTAMP(3)
           WHERE session_token_hash = ? AND revoked_at IS NULL`,
          [hashSessionToken(token)],
        );
        if (sessions[0]) {
          await recordAdminAudit(connection, sessions[0].firebase_uid, "ADMIN_LOGOUT", "admin_session", sessions[0].id);
        }
        await connection.commit();
      } finally {
        connection.release();
      }
    } catch {
      return unauthorized("Admin service unavailable", 503);
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/admin",
    maxAge: 0,
  });
  return response;
}
