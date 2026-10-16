/**
 * Utility functions for rendering notification templates with variable substitution
 */

import type {
  NotificationTemplate,
  TemplateVariableValues,
  NotificationPayload,
  NotificationType,
  DiscordPayload,
  EmailPayload,
  WebhookPayload,
  SmsPayload,
} from '../types/template';

/**
 * Extract variables from a template string
 * Variables are in the format {{variableName}}
 */
export function extractVariables(text: string): string[] {
  const variablePattern = /\{\{(\w+)\}\}/g;
  const matches = text.matchAll(variablePattern);
  const variables = new Set<string>();

  for (const match of matches) {
    if (match[1]) {
      variables.add(match[1]);
    }
  }

  return Array.from(variables);
}

/**
 * Replace variables in a string with their values
 * Variables in format {{variableName}} are replaced with values from the map
 */
export function replaceVariables(text: string, variables: TemplateVariableValues): string {
  let result = text;

  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(pattern, value);
  }

  return result;
}

/**
 * Recursively replace variables in an object
 */
function replaceVariablesInObject(obj: unknown, variables: TemplateVariableValues): unknown {
  if (typeof obj === 'string') {
    return replaceVariables(obj, variables);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => replaceVariablesInObject(item, variables));
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceVariablesInObject(value, variables);
    }
    return result;
  }

  return obj;
}

/**
 * Parse and render a template body into a structured payload
 */
export function renderTemplatePayload(
  template: NotificationTemplate,
  variables: TemplateVariableValues,
): NotificationPayload {
  try {
    // Try to parse body as JSON first (for structured payloads)
    const parsedBody = JSON.parse(template.body);
    const rendered = replaceVariablesInObject(parsedBody, variables);
    return rendered as NotificationPayload;
  } catch {
    // If not JSON, treat as plain text and create appropriate payload
    const renderedBody = replaceVariables(template.body, variables);

    switch (template.type) {
      case 'discord':
        return {
          content: renderedBody,
        } as DiscordPayload;

      case 'email':
        return {
          subject: template.subject
            ? replaceVariables(template.subject, variables)
            : 'Notification',
          body: renderedBody,
        } as EmailPayload;

      case 'sms':
        return {
          message: renderedBody,
        } as SmsPayload;

      case 'webhook':
      default:
        return {
          message: renderedBody,
        } as WebhookPayload;
    }
  }
}

/**
 * Validate that all required variables have values
 */
export function validateVariables(
  template: NotificationTemplate,
  variables: TemplateVariableValues,
): { valid: boolean; missingVariables: string[] } {
  const templateVariables = template.variables || extractVariables(template.body);
  const missingVariables = templateVariables.filter(
    (varName) => !variables[varName] || variables[varName].trim() === '',
  );

  return {
    valid: missingVariables.length === 0,
    missingVariables,
  };
}

/**
 * Get sample/default values for template variables
 */
export function getSampleVariableValues(template: NotificationTemplate): TemplateVariableValues {
  const variables = template.variables || extractVariables(template.body);
  const sampleValues: TemplateVariableValues = {};

  for (const varName of variables) {
    // Provide sensible defaults based on common variable names
    switch (varName.toLowerCase()) {
      case 'name':
      case 'username':
      case 'user':
        sampleValues[varName] = 'John Doe';
        break;
      case 'email':
        sampleValues[varName] = 'user@example.com';
        break;
      case 'amount':
      case 'reward':
      case 'price':
        sampleValues[varName] = '100';
        break;
      case 'currency':
        sampleValues[varName] = 'XLM';
        break;
      case 'taskid':
      case 'id':
        sampleValues[varName] = '42';
        break;
      case 'title':
        sampleValues[varName] = 'Sample Task Title';
        break;
      case 'description':
        sampleValues[varName] = 'This is a sample description';
        break;
      case 'date':
      case 'datetime':
      case 'timestamp':
        sampleValues[varName] = new Date().toLocaleString();
        break;
      case 'url':
      case 'link':
        sampleValues[varName] = 'https://example.com';
        break;
      default:
        sampleValues[varName] = `[${varName}]`;
    }
  }

  return sampleValues;
}

/**
 * Format notification type for display
 */
export function formatNotificationType(type: NotificationType): string {
  const typeMap: Record<NotificationType, string> = {
    discord: 'Discord',
    email: 'Email',
    webhook: 'Webhook',
    sms: 'SMS',
  };

  return typeMap[type] || type;
}

/**
 * Get icon or color for notification type
 */
export function getNotificationTypeColor(type: NotificationType): string {
  const colorMap: Record<NotificationType, string> = {
    discord: '#5865F2',
    email: '#EA4335',
    webhook: '#4285F4',
    sms: '#34A853',
  };

  return colorMap[type] || '#9aa0a6';
}
