import { Database } from '../database/database';
import logger from '../utils/logger';
import {
  CreateNotificationTemplateInput,
  AuditedNotificationTemplate,
  AuditedNotificationTemplateRow,
  TemplateAuditRecord,
  UpdateNotificationTemplateInput,
} from '../types/notification-template';
import { TemplateAuditTrail } from './template-audit-trail';
import { NotificationTemplateCache } from './notification-template-cache';

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Notification template not found: ${templateId}`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

/**
 * Persists notification templates and records immutable audit entries on update.
 */
export class NotificationTemplateRepository {
  constructor(
    private readonly db: Database,
    private readonly auditTrail: TemplateAuditTrail = new TemplateAuditTrail(db),
    private readonly cache?: NotificationTemplateCache,
  ) {}

  async create(input: CreateNotificationTemplateInput): Promise<AuditedNotificationTemplate> {
    this.validateTemplateInput(input.id, input.name, input.body);

    const now = new Date();
    const sql = `
      INSERT INTO notification_templates (
        id, name, type, subject, body, variables, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      input.id,
      input.name,
      input.type,
      input.subject ?? null,
      input.body,
      input.variables ? JSON.stringify(input.variables) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now.toISOString(),
      now.toISOString(),
    ];

    await this.db.run(sql, params);
    const template = await this.getById(input.id);
    if (!template) {
      throw new Error(`Failed to load template after create: ${input.id}`);
    }

    logger.info('Notification template created', { templateId: input.id });
    return template;
  }

  async getById(templateId: string): Promise<AuditedNotificationTemplate | undefined> {
    const row = await this.db.get<AuditedNotificationTemplateRow>(
      'SELECT * FROM notification_templates WHERE id = ?',
      [templateId],
    );
    return row ? this.rowToModel(row) : undefined;
  }

  async update(
    templateId: string,
    input: UpdateNotificationTemplateInput,
    actor: string,
  ): Promise<AuditedNotificationTemplate> {
    const trimmedActor = actor?.trim();
    if (!trimmedActor) {
      throw new TemplateValidationError('Actor is required for template updates');
    }

    const existing = await this.getById(templateId);
    if (!existing) {
      throw new TemplateNotFoundError(templateId);
    }

    const nextName = input.name ?? existing.name;
    const nextBody = input.body ?? existing.body;
    this.validateTemplateInput(templateId, nextName, nextBody);

    const updated: AuditedNotificationTemplate = {
      ...existing,
      ...input,
      name: nextName,
      body: nextBody,
      updatedAt: new Date(),
    };

    const hasChanges = this.hasTemplateChanges(existing, updated);
    if (!hasChanges) {
      return existing;
    }

    await this.db.transaction(async () => {
      await this.db.run(
        `
          UPDATE notification_templates
          SET
            name = ?,
            type = ?,
            subject = ?,
            body = ?,
            variables = ?,
            metadata = ?
          WHERE id = ?
        `,
        [
          updated.name,
          updated.type,
          updated.subject ?? null,
          updated.body,
          updated.variables ? JSON.stringify(updated.variables) : null,
          updated.metadata ? JSON.stringify(updated.metadata) : null,
          templateId,
        ],
      );

      await this.auditTrail.record({
        templateId,
        actor: trimmedActor,
        previousSnapshot: existing,
        newSnapshot: updated,
      });
    });

    this.cache?.invalidate(templateId);

    const persisted = await this.getById(templateId);
    if (!persisted) {
      throw new Error(`Failed to load template after update: ${templateId}`);
    }

    logger.info('Notification template updated', { templateId, actor: trimmedActor });
    return persisted;
  }

  async getAll(): Promise<AuditedNotificationTemplate[]> {
    const rows = await this.db.all<AuditedNotificationTemplateRow>(
      'SELECT * FROM notification_templates',
    );
    return rows.map(row => this.rowToModel(row));
  }

  async listAll(): Promise<AuditedNotificationTemplate[]> {
    const rows = await this.db.all<AuditedNotificationTemplateRow>(
      'SELECT * FROM notification_templates ORDER BY created_at DESC',
    );
    return rows.map((row) => this.rowToModel(row));
  }

  async delete(templateId: string): Promise<void> {
    const existing = await this.getById(templateId);
    if (!existing) {
      throw new TemplateNotFoundError(templateId);
    }
    await this.db.run('DELETE FROM notification_templates WHERE id = ?', [templateId]);
    this.cache?.invalidate(templateId);
    logger.info('Notification template deleted', { templateId });
  }

  async getUpdateHistory(templateId: string): Promise<TemplateAuditRecord[]> {
    return this.auditTrail.getByTemplateId(templateId);
  }

  private validateTemplateInput(templateId: string, name: string, body: string): void {
    if (!templateId?.trim()) {
      throw new TemplateValidationError('Template ID is required');
    }
    if (!name?.trim()) {
      throw new TemplateValidationError('Template name is required');
    }
    if (!body?.trim()) {
      throw new TemplateValidationError('Template body is required');
    }
  }

  private hasTemplateChanges(
    previous: AuditedNotificationTemplate,
    next: AuditedNotificationTemplate,
  ): boolean {
    return JSON.stringify(this.snapshotForComparison(previous))
      !== JSON.stringify(this.snapshotForComparison(next));
  }

  private snapshotForComparison(template: AuditedNotificationTemplate): Record<string, unknown> {
    return {
      id: template.id,
      name: template.name,
      type: template.type,
      subject: template.subject,
      body: template.body,
      variables: template.variables,
      metadata: template.metadata,
      createdAt: template.createdAt,
    };
  }

  private rowToModel(row: AuditedNotificationTemplateRow): AuditedNotificationTemplate {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      subject: row.subject ?? undefined,
      body: row.body,
      variables: row.variables ? JSON.parse(row.variables) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    } as any;
  }
}
