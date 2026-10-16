/**
 * Types for Notification Template System
 */

export enum TemplateChannelType {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  DISCORD = 'DISCORD',
  PUSH = 'PUSH',
  WEBHOOK = 'WEBHOOK',
}

export interface ChannelNotificationTemplate {
  id?: number;
  uniqueKey: string;
  name: string;
  description?: string;
  channelType: TemplateChannelType;
  subjectTemplate?: string;
  bodyTemplate: string;
  variables: string[];               // Required variables
  defaultValues: Record<string, any>;  // Default/fallback values
  isActive: boolean;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string;
  updatedBy?: string;
}

export interface CreateTemplateInput {
  uniqueKey: string;
  name: string;
  description?: string;
  channelType: TemplateChannelType;
  subjectTemplate?: string;
  bodyTemplate: string;
  variables?: string[];
  defaultValues?: Record<string, any>;
  isActive?: boolean;
  createdBy?: string;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
  variables?: string[];
  defaultValues?: Record<string, any>;
  isActive?: boolean;
  updatedBy?: string;
}

export interface RenderContext {
  [key: string]: any;  // Dynamic key-value pairs for template variables
}

export interface RenderedTemplate {
  subject?: string;
  body: string;
  variables: Record<string, any>;  // Actual values used
}

export interface TemplateValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
  detectedVariables?: string[];
}

export interface TemplateUsageLog {
  id?: number;
  templateId: number;
  renderedAt: Date;
  contextData: Record<string, any>;
  recipient?: string;
  status: 'SUCCESS' | 'FAILED';
  errorMessage?: string;
}

export interface ChannelNotificationTemplateRow {
  id: number;
  unique_key: string;
  name: string;
  description: string | null;
  channel_type: string;
  subject_template: string | null;
  body_template: string;
  variables: string;  // JSON string
  default_values: string;  // JSON string
  is_active: number;  // SQLite boolean (0 or 1)
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface AuditedNotificationTemplate {
  id: string;
  name: string;
  type: string;
  subject?: string;
  body: string;
  variables?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNotificationTemplateInput {
  id: string;
  name: string;
  type: string;
  subject?: string;
  body: string;
  variables?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateNotificationTemplateInput {
  name?: string;
  type?: string;
  subject?: string;
  body?: string;
  variables?: string[];
  metadata?: Record<string, unknown>;
}

export type TemplateAuditAction = 'UPDATE';

export interface NotificationTemplate {
  id: string;
  name: string;
  type: string;
  subject?: string;
  body: string;
  variables?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateAuditRecord {
  id: number;
  templateId: string;
  actor: string;
  action: TemplateAuditAction;
  changedAt: Date;
  previousSnapshot: AuditedNotificationTemplate;
  newSnapshot: AuditedNotificationTemplate;
}

export interface AuditedNotificationTemplateRow {
  id: string;
  name: string;
  type: string;
  subject: string | null;
  body: string;
  variables: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateAuditRecordRow {
  id: number;
  template_id: string;
  actor: string;
  action: string;
  changed_at: string;
  previous_snapshot: string;
  new_snapshot: string;
}
