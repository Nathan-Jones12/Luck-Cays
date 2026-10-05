import type { NextRequest } from "next/server";
import type { RowDataPacket } from "mysql2";
import { getDatabase } from "./database";
import { hashSessionToken } from "./crypto";

export const ADMIN_SESSION_COOKIE = "luck_cays_admin";
export const ADMIN_SESSION_TTL_SECONDS = 15 * 60;

export type AdminRole = "SUPER_ADMIN" | "CONTENT_ADMIN";

export type AdminActor = {
  firebaseUid: string;
  email: string;
  role: AdminRole;
};

type AdminSessionRow = RowDataPacket & {
  firebase_uid: string;
  email: string;
  role: AdminRole;
};

export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function getAdminActor(request: NextRequest): Promise<AdminActor | null> {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token || token.length > 128) return null;

  const [rows] = await getDatabase().execute<AdminSessionRow[]>(
    `SELECT a.firebase_uid, a.email, a.role
     FROM luck_cays_admin_sessions s
     JOIN luck_cays_admins a ON a.firebase_uid = s.firebase_uid
     WHERE s.session_token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP(3)
       AND a.status = 'ACTIVE'
       AND a.totp_enabled_at IS NOT NULL
     LIMIT 1`,
    [hashSessionToken(token)],
  );

  const admin = rows[0];
  if (!admin) return null;
  return { firebaseUid: admin.firebase_uid, email: admin.email, role: admin.role };
}
