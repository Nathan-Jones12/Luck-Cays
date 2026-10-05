import type { PoolConnection } from "mysql2/promise";
import { createId } from "./crypto";

export async function recordAdminAudit(
  connection: PoolConnection,
  actorUid: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, string | number | boolean | null> | null = null,
): Promise<void> {
  await connection.execute(
    `INSERT INTO luck_cays_audit_logs (id, actor_uid, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [createId(), actorUid, action, entityType, entityId, details ? JSON.stringify(details) : null],
  );
}
