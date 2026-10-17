/**
 * Notification Template Repository
 * 
 * Data access layer for notification templates
 * Handles all CRUD operations with the database
 */

import { Database } from '../database/database';
import logger from '../utils/logger';
import {
  ChannelNotificationTemplate,
  ChannelNotificationTemplateRow,
  CreateTemplateInput,
  UpdateTemplateInput,
  TemplateChannelType,
  TemplateUsageLog,
} from '../types/notification-template';

export class TemplateRepository {
  constructor(private db: Database) {}

  /**
   * Create a new notification template
   */
  async create(input: CreateTemplateInput): Promise<number> {
    const sql = `
      INSERT INTO channel_templates (
        unique_key, name, description, channel_type,
        subject_template, body_template, variables, default_values,
        is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      input.uniqueKey,
      input.name,
      input.description || null,
      input.channelType,
      input.subjectTemplate || null,
      input.bodyTemplate,
      JSON.stringify(input.variables || []),
      JSON.stringify(input.defaultValues || {}),
      input.isActive !== false ? 1 : 0,
      input.createdBy || null,
    ];

    const result = await this.db.run(sql, params);

    logger.info('Template created', {
      id: result.lastID,
      uniqueKey: input.uniqueKey,
      channelType: input.channelType,
    });

    return result.lastID;
  }

  /**
   * Get template by ID
   */
  async getById(id: number): Promise<ChannelNotificationTemplate | null> {
    const sql = 'SELECT * FROM channel_templates WHERE id = ?';
    const row = await this.db.get<ChannelNotificationTemplateRow>(sql, [id]);

    return row ? this.rowToModel(row) : null;
  }

  /**
   * Get template by unique key
   */
  async getByUniqueKey(uniqueKey: string): Promise<ChannelNotificationTemplate | null> {
    const sql = 'SELECT * FROM channel_templates WHERE unique_key = ?';
    const row = await this.db.get<ChannelNotificationTemplateRow>(sql, [uniqueKey]);

    return row ? this.rowToModel(row) : null;
  }

  /**
   * Get all templates with optional filters
   */
  async getAll(filters?: {
    channelType?: TemplateChannelType;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ChannelNotificationTemplate[]> {
    let sql = 'SELECT * FROM channel_templates WHERE 1=1';
    const params: any[] = [];

    if (filters?.channelType) {
      sql += ' AND channel_type = ?';
      params.push(filters.channelType);
    }

    if (filters?.isActive !== undefined) {
      sql += ' AND is_active = ?';
      params.push(filters.isActive ? 1 : 0);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);

      if (filters?.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const rows = await this.db.all<ChannelNotificationTemplateRow>(sql, params);
    return rows.map(this.rowToModel);
  }

  /**
   * Update template
   */
  async update(id: number, input: UpdateTemplateInput): Promise<boolean> {
    const updates: string[] = [];
    const params: any[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }

    if (input.subjectTemplate !== undefined) {
      updates.push('subject_template = ?');
      params.push(input.subjectTemplate);
    }

    if (input.bodyTemplate !== undefined) {
      updates.push('body_template = ?');
      params.push(input.bodyTemplate);
      // Increment version when body changes
      updates.push('version = version + 1');
    }

    if (input.variables !== undefined) {
      updates.push('variables = ?');
      params.push(JSON.stringify(input.variables));
    }

    if (input.defaultValues !== undefined) {
      updates.push('default_values = ?');
      params.push(JSON.stringify(input.defaultValues));
    }

    if (input.isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(input.isActive ? 1 : 0);
    }

    if (input.updatedBy !== undefined) {
      updates.push('updated_by = ?');
      params.push(input.updatedBy);
    }

    if (updates.length === 0) {
      return false;
    }

    params.push(id);

    const sql = `
      UPDATE channel_templates 
      SET ${updates.join(', ')} 
      WHERE id = ?
    `;

    const result = await this.db.run(sql, params);

    if (result.changes > 0) {
      logger.info('Template updated', { id, updates: updates.length });
      return true;
    }

    return false;
  }

  /**
   * Delete template (soft delete by marking inactive)
   */
  async deactivate(id: number): Promise<boolean> {
    const sql = 'UPDATE channel_templates SET is_active = 0 WHERE id = ?';
    const result = await this.db.run(sql, [id]);

    if (result.changes > 0) {
      logger.info('Template deactivated', { id });
      return true;
    }

    return false;
  }

  /**
   * Hard delete template (permanent deletion)
   */
  async delete(id: number): Promise<boolean> {
    const sql = 'DELETE FROM channel_templates WHERE id = ?';
    const result = await this.db.run(sql, [id]);

    if (result.changes > 0) {
      logger.info('Template deleted', { id });
      return true;
    }

    return false;
  }

  /**
   * Check if unique key exists
   */
  async exists(uniqueKey: string): Promise<boolean> {
    const sql = 'SELECT COUNT(*) as count FROM channel_templates WHERE unique_key = ?';
    const result = await this.db.get<{ count: number }>(sql, [uniqueKey]);
    return (result?.count || 0) > 0;
  }

  /**
   * Log template usage
   */
  async logUsage(log: TemplateUsageLog): Promise<void> {
    const sql = `
      INSERT INTO template_usage_log (
        template_id, context_data, recipient, status, error_message
      ) VALUES (?, ?, ?, ?, ?)
    `;

    await this.db.run(sql, [
      log.templateId,
      JSON.stringify(log.contextData),
      log.recipient || null,
      log.status,
      log.errorMessage || null,
    ]);
  }

  /**
   * Get template usage statistics
   */
  async getUsageStats(templateId: number): Promise<{
    totalUses: number;
    successCount: number;
    failureCount: number;
    lastUsed: Date | null;
  }> {
    const sql = `
      SELECT 
        COUNT(*) as total_uses,
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failure_count,
        MAX(rendered_at) as last_used
      FROM template_usage_log
      WHERE template_id = ?
    `;

    const result = await this.db.get<{
      total_uses: number;
      success_count: number;
      failure_count: number;
      last_used: string | null;
    }>(sql, [templateId]);

    return {
      totalUses: result?.total_uses || 0,
      successCount: result?.success_count || 0,
      failureCount: result?.failure_count || 0,
      lastUsed: result?.last_used ? new Date(result.last_used) : null,
    };
  }

  /**
   * Get template count by channel type
   */
  async getCountByChannel(): Promise<Record<string, number>> {
    const sql = `
      SELECT channel_type, COUNT(*) as count
      FROM channel_templates
      WHERE is_active = 1
      GROUP BY channel_type
    `;

    const rows = await this.db.all<{ channel_type: string; count: number }>(sql);

    const counts: Record<string, number> = {};
    rows.forEach((row) => {
      counts[row.channel_type] = row.count;
    });

    return counts;
  }

  /**
   * Convert database row to model
   */
  private rowToModel(row: ChannelNotificationTemplateRow): ChannelNotificationTemplate {
    return {
      id: row.id,
      uniqueKey: row.unique_key,
      name: row.name,
      description: row.description || undefined,
      channelType: row.channel_type as TemplateChannelType,
      subjectTemplate: row.subject_template || undefined,
      bodyTemplate: row.body_template,
      variables: JSON.parse(row.variables || '[]'),
      defaultValues: JSON.parse(row.default_values || '{}'),
      isActive: row.is_active === 1,
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      createdBy: row.created_by || undefined,
      updatedBy: row.updated_by || undefined,
    };
  }
}
