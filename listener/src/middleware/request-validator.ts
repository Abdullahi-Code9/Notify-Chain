/**
 * Centralized Request Validation Middleware (#851)
 *
 * Intercepts incoming API requests to validate payloads before they reach business logic.
 *
 * Acceptance Criteria:
 * - Invalid payloads are rejected consistently.
 * - Validation errors use a standard response format (conforming to utils/response.ts).
 * - Existing valid requests remain compatible.
 */

import http from 'http';
import { sendErr, ErrorCode } from '../utils/response';
import {
  ValidationIssue,
  ValidationError,
  isPlainObject,
  isNonEmptyString,
  isInteger,
  isValidDate,
  isOneOf,
} from '../utils/validation';
import logger from '../utils/logger';

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'date'
  | 'any';

export interface FieldRule<T = unknown> {
  type: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  allowedValues?: readonly unknown[];
  validator?: (value: unknown, root: Record<string, unknown>) => string | null | undefined;
  transform?: (value: unknown) => T;
}

export type SchemaRules<T = Record<string, unknown>> = {
  [K in keyof T]?: FieldRule<T[K]>;
} & Record<string, FieldRule<unknown>>;

export interface RequestSchema<T = Record<string, unknown>> {
  name: string;
  fields: SchemaRules<T>;
  customValidator?: (data: Record<string, unknown>) => string | null | undefined;
}

/**
 * Validates any payload object against a declarative RequestSchema.
 */
export function validatePayload<T = Record<string, unknown>>(
  payload: unknown,
  schema: RequestSchema<T>
): { valid: boolean; data?: T; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(payload)) {
    return {
      valid: false,
      issues: [{ field: 'body', message: 'Request body must be a valid JSON object' }],
    };
  }

  const data = payload as Record<string, unknown>;

  for (const [fieldName, rule] of Object.entries(schema.fields) as [string, FieldRule][]) {
    const val = data[fieldName];

    // Check required
    if (val === undefined || val === null || val === '') {
      if (rule.required) {
        issues.push({ field: fieldName, message: `Field '${fieldName}' is required` });
      }
      continue;
    }

    // Type checking
    switch (rule.type) {
      case 'string':
        if (typeof val !== 'string') {
          issues.push({ field: fieldName, message: `Field '${fieldName}' must be a string` });
        } else {
          if (rule.min !== undefined && val.length < rule.min) {
            issues.push({
              field: fieldName,
              message: `Field '${fieldName}' must be at least ${rule.min} characters`,
            });
          }
          if (rule.max !== undefined && val.length > rule.max) {
            issues.push({
              field: fieldName,
              message: `Field '${fieldName}' must be at most ${rule.max} characters`,
            });
          }
        }
        break;

      case 'number':
        if (typeof val !== 'number' || Number.isNaN(val)) {
          issues.push({ field: fieldName, message: `Field '${fieldName}' must be a number` });
        } else {
          if (rule.min !== undefined && val < rule.min) {
            issues.push({ field: fieldName, message: `Field '${fieldName}' must be >= ${rule.min}` });
          }
          if (rule.max !== undefined && val > rule.max) {
            issues.push({ field: fieldName, message: `Field '${fieldName}' must be <= ${rule.max}` });
          }
        }
        break;

      case 'integer':
        if (!isInteger(val)) {
          issues.push({ field: fieldName, message: `Field '${fieldName}' must be an integer` });
        } else {
          if (rule.min !== undefined && (val as number) < rule.min) {
            issues.push({ field: fieldName, message: `Field '${fieldName}' must be >= ${rule.min}` });
          }
          if (rule.max !== undefined && (val as number) > rule.max) {
            issues.push({ field: fieldName, message: `Field '${fieldName}' must be <= ${rule.max}` });
          }
        }
        break;

      case 'boolean':
        if (typeof val !== 'boolean') {
          issues.push({ field: fieldName, message: `Field '${fieldName}' must be a boolean` });
        }
        break;

      case 'object':
        if (!isPlainObject(val)) {
          issues.push({ field: fieldName, message: `Field '${fieldName}' must be an object` });
        }
        break;

      case 'array':
        if (!Array.isArray(val)) {
          issues.push({ field: fieldName, message: `Field '${fieldName}' must be an array` });
        } else {
          if (rule.min !== undefined && val.length < rule.min) {
            issues.push({
              field: fieldName,
              message: `Field '${fieldName}' must contain at least ${rule.min} item(s)`,
            });
          }
          if (rule.max !== undefined && val.length > rule.max) {
            issues.push({
              field: fieldName,
              message: `Field '${fieldName}' must contain at most ${rule.max} item(s)`,
            });
          }
        }
        break;

      case 'date':
        if (!isValidDate(val)) {
          issues.push({
            field: fieldName,
            message: `Field '${fieldName}' must be a valid date or ISO string`,
          });
        }
        break;

      case 'any':
      default:
        break;
    }

    // Check allowed values
    if (rule.allowedValues && rule.allowedValues.length > 0) {
      if (!rule.allowedValues.includes(val)) {
        issues.push({
          field: fieldName,
          message: `Field '${fieldName}' must be one of: ${rule.allowedValues.join(', ')}`,
        });
      }
    }

    // Custom validator
    if (rule.validator) {
      const customErr = rule.validator(val, data);
      if (customErr) {
        issues.push({ field: fieldName, message: customErr });
      }
    }
  }

  // Schema-level custom validator
  if (schema.customValidator) {
    const schemaErr = schema.customValidator(data);
    if (schemaErr) {
      issues.push({ field: '_schema', message: schemaErr });
    }
  }

  return {
    valid: issues.length === 0,
    data: issues.length === 0 ? (data as unknown as T) : undefined,
    issues,
  };
}

/**
 * Standard schemas for central NotifyChain API endpoints
 */
export const Schemas = {
  /**
   * Schedule Notification Schema (POST /api/schedule)
   */
  scheduleNotification: {
    name: 'ScheduleNotification',
    fields: {
      executeAt: {
        type: 'date',
        required: true,
        validator: (val) => {
          const d = new Date(val as string);
          if (isNaN(d.getTime())) return 'executeAt is not a valid date';
          return null;
        },
      },
      payload: {
        type: 'object',
        required: true,
        validator: (val) => {
          if (!val || typeof val !== 'object' || Array.isArray(val) || Object.keys(val).length === 0) {
            return 'payload must be a non-empty object';
          }
          return null;
        },
      },
      targetRecipient: {
        type: 'string',
        required: true,
        min: 1,
      },
      notificationType: {
        type: 'string',
        required: false,
        allowedValues: ['discord', 'email', 'webhook', 'sms'],
      },
      maxRetries: {
        type: 'integer',
        required: false,
        min: 0,
        max: 20,
      },
      priority: {
        type: 'integer',
        required: false,
        min: 1,
        max: 10,
      },
      contractAddress: {
        type: 'string',
        required: false,
      },
      eventId: {
        type: 'string',
        required: false,
      },
      metadata: {
        type: 'object',
        required: false,
      },
    },
  } as RequestSchema<{
    executeAt: string | Date;
    payload: Record<string, unknown>;
    targetRecipient: string;
    notificationType?: string;
    maxRetries?: number;
    priority?: number;
    contractAddress?: string;
    eventId?: string;
    metadata?: Record<string, unknown>;
  }>,

  /**
   * Create Notification Template Schema (POST /api/templates)
   */
  createTemplate: {
    name: 'CreateTemplate',
    fields: {
      id: { type: 'string', required: true, min: 1 },
      name: { type: 'string', required: true, min: 1 },
      type: { type: 'string', required: true, min: 1 },
      body: { type: 'string', required: true, min: 1 },
      subject: { type: 'string', required: false },
      variables: { type: 'any', required: false },
      metadata: { type: 'object', required: false },
    },
  } as RequestSchema<{
    id: string;
    name: string;
    type: string;
    body: string;
    subject?: string;
    variables?: unknown;
    metadata?: Record<string, unknown>;
  }>,

  /**
   * Render Notification Template Schema (POST /api/templates/:id/render)
   */
  renderTemplate: {
    name: 'RenderTemplate',
    fields: {
      variables: { type: 'object', required: false },
    },
  } as RequestSchema<{ variables?: Record<string, unknown> }>,

  /**
   * Batch Validation Schema (POST /api/notifications/validate-batch)
   */
  batchValidate: {
    name: 'BatchValidate',
    fields: {
      notifications: { type: 'array', required: true, min: 1, max: 1000 },
    },
  } as RequestSchema<{ notifications: unknown[] }>,

  /**
   * Preferences Schema (PUT /api/preferences/:id)
   */
  updatePreferences: {
    name: 'UpdatePreferences',
    fields: {
      enabledChannels: { type: 'array', required: false },
      filters: { type: 'object', required: false },
    },
  } as RequestSchema<{ enabledChannels?: string[]; filters?: Record<string, unknown> }>,

  /**
   * Data Export Schema (GET/POST /api/admin/export)
   */
  dataExport: {
    name: 'DataExport',
    fields: {
      type: { type: 'string', required: false, allowedValues: ['notifications', 'events', 'all'] },
      format: { type: 'string', required: false, allowedValues: ['json', 'csv'] },
      status: { type: 'string', required: false },
      limit: { type: 'integer', required: false, min: 1, max: 10000 },
      offset: { type: 'integer', required: false, min: 0 },
      fromDate: { type: 'date', required: false },
      toDate: { type: 'date', required: false },
    },
  } as RequestSchema<Record<string, unknown>>,
};

/**
 * Safely buffers incoming request body stream, validates size limits,
 * parses JSON, and validates fields against schema.
 * Rejects with standardized error response if invalid.
 */
export async function parseAndValidateBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  schema: RequestSchema<T>,
  options: {
    maxSizeBytes?: number;
    requestId?: string;
    correlationId?: string;
  } = {}
): Promise<T | null> {
  const maxBytes = options.maxSizeBytes ?? 1024 * 1024; // 1 MB default
  let bodyBuffer = '';
  let receivedBytes = 0;

  try {
    for await (const chunk of req) {
      receivedBytes += (chunk as Buffer).length;
      if (receivedBytes > maxBytes) {
        logger.warn('Request body exceeded size limit', {
          requestId: options.requestId,
          correlationId: options.correlationId,
          receivedBytes,
          maxBytes,
        });
        sendErr(
          res,
          413,
          `Payload too large: request body exceeds limit of ${maxBytes} bytes`,
          ErrorCode.PAYLOAD_TOO_LARGE,
          [{ field: 'body', message: `Exceeded maximum size of ${maxBytes} bytes` }]
        );
        return null;
      }
      bodyBuffer += chunk;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyBuffer || '{}');
    } catch (syntaxError) {
      logger.warn('Malformed JSON payload received', {
        requestId: options.requestId,
        correlationId: options.correlationId,
        error: (syntaxError as Error).message,
      });
      sendErr(
        res,
        400,
        'Malformed JSON payload in request body',
        ErrorCode.PARSE_ERROR,
        [{ field: 'body', message: (syntaxError as Error).message }]
      );
      return null;
    }

    const { valid, data, issues } = validatePayload<T>(parsed, schema);

    if (!valid || !data) {
      const firstIssue = issues[0]?.message || 'Validation failed';
      logger.warn(`Request validation failed for schema ${schema.name}`, {
        requestId: options.requestId,
        correlationId: options.correlationId,
        schema: schema.name,
        issues,
      });
      sendErr(
        res,
        400,
        `Validation failed: ${firstIssue}`,
        ErrorCode.BAD_REQUEST,
        issues
      );
      return null;
    }

    return data;
  } catch (err) {
    logger.error('Unexpected error parsing request body', {
      error: err,
      requestId: options.requestId,
      correlationId: options.correlationId,
    });
    sendErr(
      res,
      500,
      'Internal server error while parsing request',
      ErrorCode.INTERNAL_ERROR
    );
    return null;
  }
}
