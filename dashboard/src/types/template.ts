/**
 * Types for notification templates and preview functionality
 */

export interface NotificationTemplate {
  id: string;
  name: string;
  type: NotificationType;
  subject?: string;
  body: string;
  variables?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export enum NotificationType {
  DISCORD = 'discord',
  EMAIL = 'email',
  WEBHOOK = 'webhook',
  SMS = 'sms',
}

export interface TemplateVariableValues {
  [key: string]: string;
}

export interface DiscordPayload {
  content?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
    timestamp?: string;
  }>;
}

export interface EmailPayload {
  subject: string;
  body: string;
  from?: string;
  to?: string;
  html?: string;
}

export interface WebhookPayload {
  [key: string]: unknown;
}

export interface SmsPayload {
  message: string;
  phoneNumber?: string;
}

export type NotificationPayload = DiscordPayload | EmailPayload | WebhookPayload | SmsPayload;

export interface TemplatePreviewData {
  template: NotificationTemplate;
  variableValues: TemplateVariableValues;
  renderedPayload: NotificationPayload;
  targetRecipient?: string;
  priority?: number;
  maxRetries?: number;
}
