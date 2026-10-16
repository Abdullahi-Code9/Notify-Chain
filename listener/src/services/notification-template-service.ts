import {
  CreateNotificationTemplateInput,
  AuditedNotificationTemplate,
  TemplateAuditRecord,
  UpdateNotificationTemplateInput,
} from '../types/notification-template';
import { NotificationTemplateRepository } from './notification-template-repository';
import { getTemplateCache, NotificationTemplateCache } from './notification-template-cache';

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/**
 * Application entry point for notification templates.
 * All reads go through cache; all writes go through the repository (with audit).
 */
export class NotificationTemplateService {
  constructor(
    private readonly repository: NotificationTemplateRepository,
    private readonly cache: NotificationTemplateCache = getTemplateCache(),
  ) {}

  async create(input: CreateNotificationTemplateInput): Promise<AuditedNotificationTemplate> {
    const template = await this.repository.create(input);
    this.cache.set(String(template.id ?? ''), template);
    return template;
  }

  async listAll(): Promise<AuditedNotificationTemplate[]> {
    return this.repository.listAll();
  }

  async delete(templateId: string): Promise<void> {
    await this.repository.delete(templateId);
    this.cache.invalidate(templateId);
  }

  /**
   * Renders a template by substituting variables with provided values.
   * Returns the rendered subject and body, or throws if required variables are missing.
   */
  renderTemplate(
    template: AuditedNotificationTemplate,
    variables: Record<string, string>,
  ): { subject?: string; body: string } {
    const declared = template.variables ?? [];
    const missing = declared.filter((v) => !(v in variables));
    if (missing.length > 0) {
      throw new TemplateRenderError(`Missing required variables: ${missing.join(', ')}`);
    }

    const render = (text: string): string =>
      text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        if (key in variables) return variables[key];
        throw new TemplateRenderError(`Unknown variable: ${key}`);
      });

    return {
      ...(template.subject !== undefined ? { subject: render(template.subject) } : {}),
      body: render(template.body),
    };
  }

  async getById(templateId: string): Promise<AuditedNotificationTemplate | undefined> {
    return this.cache.getOrLoad(templateId, () => this.repository.getById(templateId));
  }

  async update(
    templateId: string,
    input: UpdateNotificationTemplateInput,
    actor: string,
  ): Promise<AuditedNotificationTemplate> {
    return this.repository.update(templateId, input, actor);
  }

  async getAll(): Promise<AuditedNotificationTemplate[]> {
    return this.repository.getAll();
  }

  async getAuditHistory(templateId: string): Promise<TemplateAuditRecord[]> {
    return this.repository.getUpdateHistory(templateId);
  }
}
