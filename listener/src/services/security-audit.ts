import { Database } from '../database/database';
import logger from '../utils/logger';

/**
 * Structured audit record for security‑sensitive actions (authentication failures, permission changes, admin actions).
 * The table `security_audit_log` is created by migration `003-add-security-audit-log.sql`.
 */
export interface SecurityAuditRecord {
  id: number;
  action: string; // e.g., 'auth_failure', 'permission_change', 'admin_action'
  actor: string; // identifier of the entity performing the action (e.g., keyId, userId)
  timestamp: string; // ISO8601
  sourceIp?: string;
  requestId?: string;
  correlationId?: string;
  outcome: string; // e.g., 'AUTH_MISSING_SIGNATURE', 'http_401'
  details?: Record<string, unknown>; // additional context, **must not contain credentials**
}

export interface SecurityAuditInput {
  action: string;
  actor: string;
  sourceIp?: string;
  requestId?: string;
  correlationId?: string;
  outcome: string;
  details?: Record<string, unknown>;
}

export class SecurityAuditService {
  constructor(private readonly db: Database) {}

  async record(input: SecurityAuditInput): Promise<number> {
    const timestamp = new Date().toISOString();
    const sql = `
      INSERT INTO security_audit_log (
        action, actor, timestamp, source_ip, request_id, correlation_id, outcome, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      input.action,
      input.actor,
      timestamp,
      input.sourceIp ?? null,
      input.requestId ?? null,
      input.correlationId ?? null,
      input.outcome,
      input.details ? JSON.stringify(input.details) : null,
    ];
    const result = await this.db.run(sql, params);
    logger.info('Security audit record created', {
      auditId: result.lastID,
      action: input.action,
      actor: input.actor,
      outcome: input.outcome,
    });
    return result.lastID;
  }
}
