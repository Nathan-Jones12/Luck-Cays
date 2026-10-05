import type { RowDataPacket } from "mysql2";
import { getDatabase } from "./database";
import { verifyFirebaseIdToken, type FirebaseIdentity } from "./firebase-token";

export type AdminIdentityRecord = RowDataPacket & {
  firebase_uid: string;
  email: string;
  role: "SUPER_ADMIN" | "CONTENT_ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  totp_secret_ciphertext: Buffer | null;
  totp_enabled_at: Date | string | null;
  last_totp_counter: string | number | null;
};

export async function getRecentVerifiedIdentity(idToken: string): Promise<FirebaseIdentity> {
  const identity = await verifyFirebaseIdToken(idToken);
  if (!identity.emailVerified || Date.now() / 1000 - identity.authTime > 300) {
    throw new Error("Recent verified Firebase sign-in required");
  }
  return identity;
}

export async function findActiveAdmin(firebaseUid: string): Promise<AdminIdentityRecord | null> {
  const [rows] = await getDatabase().execute<AdminIdentityRecord[]>(
    `SELECT firebase_uid, email, role, status, totp_secret_ciphertext,
            totp_enabled_at, last_totp_counter
     FROM luck_cays_admins
     WHERE firebase_uid = ? AND status = 'ACTIVE'
     LIMIT 1`,
    [firebaseUid],
  );
  return rows[0] ?? null;
}
