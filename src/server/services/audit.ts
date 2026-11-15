import { query } from "../db.js";

export interface AuditInput {
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_events (actor, action, target_type, target_id, metadata, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.actor.slice(0, 120),
        input.action.slice(0, 120),
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ipHash ?? null,
      ],
    );
  } catch (error) {
    // Auditing must not break the user request, but it must be visible in logs.
    console.error("Audit write failed", error instanceof Error ? error.message : error);
  }
}
