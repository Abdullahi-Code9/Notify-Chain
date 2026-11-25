/**
 * Notification Template REST API
 * 
 * HTTP endpoints for template CRUD operations
 * - POST   /api/templates        - Create template
 * - GET    /api/templates        - List templates
 * - GET    /api/templates/:id    - Get template by ID
 * - PUT    /api/templates/:id    - Update template
 * - DELETE /api/templates/:id    - Delete template
 * - POST   /api/templates/render - Render template
 * - GET    /api/templates/stats  - Get statistics
 *
 * Authorization boundaries:
 * - Administrative (write) routes require the `templates:write` permission:
 *     POST   /api/templates          -> templates:write
 *     PUT    /api/templates/:id      -> templates:write
 *     DELETE /api/templates/:id      -> templates:write
 *     POST   /api/templates/render   -> templates:write
 * - Read-only routes require the `templates:read` permission:
 *     GET    /api/templates          -> templates:read
 *     GET    /api/templates/:id      -> templates:read
 *     GET    /api/templates/stats    -> templates:read
 *     GET    /api/templates/:id/stats -> templates:read
 * Requests lacking the required permission are rejected with 403.
 */

import * as http from 'http';
import { TemplateService } from '../services/template-service';
import logger from '../utils/logger';
import { TemplateChannelType } from '../types/notification-template';
import { sendOk, sendErr, ErrorCode } from '../utils/response';

export const TEMPLATE_READ_PERMISSION = 'templates:read';
export const TEMPLATE_WRITE_PERMISSION = 'templates:write';

export interface TemplateAPIOptions {
  templateService: TemplateService;
  corsOrigin?: string;
  /**
   * Resolve the permissions granted to the caller of a request.
   * Defaults to granting no permissions (all privileged routes rejected).
   */
  resolvePermissions?: (req: http.IncomingMessage) => string[] | Promise<string[]>;
}

/**
 * Resolve the permissions granted to the request caller.
 */
async function resolvePermissions(
  req: http.IncomingMessage,
  resolver?: TemplateAPIOptions['resolvePermissions']
): Promise<string[]> {
  if (!resolver) {
    return [];
  }
  try {
    const permissions = await resolver(req);
    return Array.isArray(permissions) ? permissions : [];
  } catch (error) {
    logger.error('Failed to resolve request permissions', { error });
    return [];
  }
}

/**
 * Check whether the caller holds the required permission.
 */
function hasPermission(permissions: string[], required: string): boolean {
  return permissions.includes(required);
}

/**
 * Parse JSON body from request
 */
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Template API Request Handler
 */
export function createTemplateAPIHandler(options: TemplateAPIOptions) {
  const { templateService, corsOrigin = '*', resolvePermissions: permissionResolver } = options;

  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const pathname = url.pathname;

      // Determine the permission required for this route.
      // Administrative (write) routes require templates:write; read-only routes require templates:read.
      let requiredPermission: string | null = null;
      if (req.method === 'POST' && pathname === '/api/templates') {
        requiredPermission = TEMPLATE_WRITE_PERMISSION;
      } else if (req.method === 'POST' && pathname === '/api/templates/render') {
        requiredPermission = TEMPLATE_WRITE_PERMISSION;
      } else if (req.method === 'PUT' && pathname.startsWith('/api/templates/')) {
        requiredPermission = TEMPLATE_WRITE_PERMISSION;
      } else if (req.method === 'DELETE' && pathname.startsWith('/api/templates/')) {
        requiredPermission = TEMPLATE_WRITE_PERMISSION;
      } else if (req.method === 'GET' && pathname === '/api/templates') {
        requiredPermission = TEMPLATE_READ_PERMISSION;
      } else if (req.method === 'GET' && pathname === '/api/templates/stats') {
        requiredPermission = TEMPLATE_READ_PERMISSION;
      } else if (req.method === 'GET' && pathname.match(/^\/api\/templates\/\d+\/stats$/)) {
        requiredPermission = TEMPLATE_READ_PERMISSION;
      } else if (req.method === 'GET' && pathname.startsWith('/api/templates/')) {
        requiredPermission = TEMPLATE_READ_PERMISSION;
      }

      if (requiredPermission) {
        const permissions = await resolvePermissions(req, permissionResolver);
        if (!hasPermission(permissions, requiredPermission)) {
          logger.warn('Template API access denied', {
            method: req.method,
            path: pathname,
            requiredPermission,
          });
          sendErr(
            res,
            403,
            `Forbidden: missing required permission '${requiredPermission}'`,
            ErrorCode.FORBIDDEN
          );
          return;
        }
      }

      // POST /api/templates - Create template (requires templates:write)
      if (req.method === 'POST' && pathname === '/api/templates') {
        const body = await parseBody(req);

        if (!body.uniqueKey || !body.name || !body.channelType || !body.bodyTemplate) {
          sendErr(res, 400, 'Missing required fields: uniqueKey, name, channelType, bodyTemplate', ErrorCode.BAD_REQUEST);
          return;
        }

        const result = await templateService.createTemplate(body);

        if (!result.success) {
          sendErr(res, 400, result.error ?? 'Template creation failed', ErrorCode.BAD_REQUEST, result.validation);
          return;
        }

        sendOk(res, 201, {
          id: result.templateId,
          message: 'Template created successfully',
          validation: result.validation,
        });
        return;
      }

      // GET /api/templates - List templates (requires templates:read)
      if (req.method === 'GET' && pathname === '/api/templates') {
        const channelType = url.searchParams.get('channelType') as TemplateChannelType | null;
        const isActive = url.searchParams.get('isActive');
        const limit = url.searchParams.get('limit');
        const offset = url.searchParams.get('offset');

        const templates = await templateService.listTemplates({
          channelType: channelType || undefined,
          isActive: isActive ? isActive === 'true' : undefined,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });

        sendOk(res, 200, { count: templates.length, templates });
        return;
      }

      // GET /api/templates/stats - Get statistics (requires templates:read)
      if (req.method === 'GET' && pathname === '/api/templates/stats') {
        const stats = await templateService.getOverviewStats();
        sendOk(res, 200, stats);
        return;
      }

      // GET /api/templates/:id - Get template by ID (requires templates:read)
      if (req.method === 'GET' && pathname.startsWith('/api/templates/')) {
        const id = parseInt(pathname.split('/').pop() || '', 10);

        if (isNaN(id)) {
          sendErr(res, 400, 'Invalid template ID', ErrorCode.BAD_REQUEST);
          return;
        }

        const template = await templateService.getTemplate(id);

        if (!template) {
          sendErr(res, 404, 'Template not found', ErrorCode.NOT_FOUND);
          return;
        }

        sendOk(res, 200, template);
        return;
      }

      // PUT /api/templates/:id - Update template (requires templates:write)
      if (req.method === 'PUT' && pathname.startsWith('/api/templates/')) {
        const id = parseInt(pathname.split('/').pop() || '', 10);

        if (isNaN(id)) {
          sendErr(res, 400, 'Invalid template ID', ErrorCode.BAD_REQUEST);
          return;
        }

        const body = await parseBody(req);
        const result = await templateService.updateTemplate(id, body);

        if (!result.success) {
          sendErr(res, 400, result.error ?? 'Template update failed', ErrorCode.BAD_REQUEST, result.validation);
          return;
        }

        sendOk(res, 200, { message: 'Template updated successfully', validation: result.validation });
        return;
      }

      // DELETE /api/templates/:id - Delete template (requires templates:write)
      if (req.method === 'DELETE' && pathname.startsWith('/api/templates/')) {
        const id = parseInt(pathname.split('/').pop() || '', 10);

        if (isNaN(id)) {
          sendErr(res, 400, 'Invalid template ID', ErrorCode.BAD_REQUEST);
          return;
        }

        const hardDelete = url.searchParams.get('hard') === 'true';

        const success = hardDelete
          ? await templateService.deleteTemplate(id)
          : await templateService.deactivateTemplate(id);

        if (!success) {
          sendErr(res, 404, 'Template not found', ErrorCode.NOT_FOUND);
          return;
        }

        sendOk(res, 200, {
          message: hardDelete ? 'Template deleted permanently' : 'Template deactivated',
        });
        return;
      }

      // POST /api/templates/render - Render template (requires templates:write)
      if (req.method === 'POST' && pathname === '/api/templates/render') {
        const body = await parseBody(req);

        if (!body.template || !body.context) {
          sendErr(res, 400, 'Missing required fields: template (ID or uniqueKey), context', ErrorCode.BAD_REQUEST);
          return;
        }

        const result = await templateService.renderTemplate(body.template, body.context);

        if (!result.success) {
          sendErr(res, 400, result.error ?? 'Render failed', ErrorCode.BAD_REQUEST, { missingVariables: result.missingVariables });
          return;
        }

        sendOk(res, 200, { rendered: result.rendered });
        return;
      }

      // GET /api/templates/:id/stats - Get template usage stats (requires templates:read)
      if (req.method === 'GET' && pathname.match(/^\/api\/templates\/\d+\/stats$/)) {
        const id = parseInt(pathname.split('/')[3], 10);
        const stats = await templateService.getTemplateStats(id);
        sendOk(res, 200, stats);
        return;
      }

      // Not found
      sendErr(res, 404, 'Endpoint not found', ErrorCode.NOT_FOUND);
    } catch (error) {
      logger.error('Template API error', { error, path: url.pathname });
      sendErr(res, 500, error instanceof Error ? error.message : 'Unknown error', ErrorCode.INTERNAL_ERROR);
    }
  };
}
import { resolveRequestActor } from '../utils/request-actor';
import {
  AuditedNotificationTemplate,
  TemplateAuditRecord,
  UpdateNotificationTemplateInput,
} from '../types/notification-template';

export function serializeTemplate(template: AuditedNotificationTemplate): Record<string, unknown> {
  return {
    ...template,
    createdAt: template.createdAt ? template.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: template.updatedAt ? template.updatedAt.toISOString() : new Date().toISOString(),
  };
}

export function serializeAuditRecord(record: TemplateAuditRecord): Record<string, unknown> {
  return {
    id: record.id,
    templateId: record.templateId,
    actor: record.actor,
    action: record.action,
    changedAt: record.changedAt.toISOString(),
    previousSnapshot: serializeTemplate(normalizeSnapshot(record.previousSnapshot)),
    newSnapshot: serializeTemplate(normalizeSnapshot(record.newSnapshot)),
  };
}

function normalizeSnapshot(snapshot: AuditedNotificationTemplate): AuditedNotificationTemplate {
  return {
    ...snapshot,
    createdAt: snapshot.createdAt instanceof Date
      ? snapshot.createdAt
      : new Date(snapshot.createdAt as unknown as string),
    updatedAt: snapshot.updatedAt instanceof Date
      ? snapshot.updatedAt
      : new Date(snapshot.updatedAt as unknown as string),
  };
}

export function parseTemplateUpdateBody(body: unknown): UpdateNotificationTemplateInput {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid body: expected a template update object');
  }

  const input = body as Record<string, unknown>;
  const update: UpdateNotificationTemplateInput = {};

  if ('name' in input) {
    if (typeof input.name !== 'string') {
      throw new Error('Invalid body: name must be a string');
    }
    update.name = input.name;
  }
  if ('type' in input) {
    if (typeof input.type !== 'string') {
      throw new Error('Invalid body: type must be a string');
    }
    update.type = input.type;
  }
  if ('subject' in input) {
    if (input.subject !== undefined && input.subject !== null && typeof input.subject !== 'string') {
      throw new Error('Invalid body: subject must be a string');
    }
    update.subject = input.subject as string | undefined;
  }
  if ('body' in input) {
    if (typeof input.body !== 'string') {
      throw new Error('Invalid body: body must be a string');
    }
    update.body = input.body;
  }
  if ('variables' in input) {
    if (!Array.isArray(input.variables) || input.variables.some((v) => typeof v !== 'string')) {
      throw new Error('Invalid body: variables must be an array of strings');
    }
    update.variables = input.variables;
  }
  if ('metadata' in input) {
    if (input.metadata !== null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
      throw new Error('Invalid body: metadata must be an object');
    }
    update.metadata = input.metadata as Record<string, unknown>;
  }

  if (Object.keys(update).length === 0) {
    throw new Error('Invalid body: at least one template field must be provided');
  }

  return update;
}

export { resolveRequestActor };

// Route-level authorization tests
if (process.env.NODE_ENV === 'test' && typeof describe === 'function') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http') as typeof import('http');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createTemplateAPIHandler, TEMPLATE_READ_PERMISSION, TEMPLATE_WRITE_PERMISSION } =
    require('./template-api') as typeof import('./template-api');

  describe('template API route authorization', () => {
    const createService = () => ({
      createTemplate: jest.fn().mockResolvedValue({ success: true, templateId: 1 }),
      listTemplates: jest.fn().mockResolvedValue([]),
      getOverviewStats: jest.fn().mockResolvedValue({ total: 0 }),
      getTemplate: jest.fn().mockResolvedValue({ id: 1 }),
      updateTemplate: jest.fn().mockResolvedValue({ success: true }),
      deleteTemplate: jest.fn().mockResolvedValue(true),
      deactivateTemplate: jest.fn().mockResolvedValue(true),
      renderTemplate: jest.fn().mockResolvedValue({ success: true, rendered: 'x' }),
      getTemplateStats: jest.fn().mockResolvedValue({ usage: 0 }),
    });

    const invoke = async (
      handler: ReturnType<typeof createTemplateAPIHandler>,
      method: string,
      path: string
    ) => {
      const req = { method, on: jest.fn(), headers: {} } as unknown as http.IncomingMessage;
      const res = {
        statusCode: 0,
        body: '',
        setHeader: jest.fn(),
        writeHead: jest.fn(),
        end: jest.fn(),
        write: jest.fn(),
      } as unknown as http.ServerResponse & { statusCode: number; body: string };
      let statusCode = 0;
      let body = '';
      (res as any).statusCode = 0;
      (res as any).writeHead = (code: number) => {
        statusCode = code;
        (res as any).statusCode = code;
      };
      (res as any).end = (chunk?: string) => {
        if (chunk) body += chunk;
        (res as any).body = body;
      };
      (res as any).write = (chunk: string) => {
        body += chunk;
        (res as any).body = body;
      };
      await handler(req, res, new URL(`http://localhost${path}`));
      return { statusCode, body };
    };

    const writeRoutes: Array<[string, string]> = [
      ['POST', '/api/templates'],
      ['PUT', '/api/templates/1'],
      ['DELETE', '/api/templates/1'],
      ['POST', '/api/templates/render'],
    ];

    const readRoutes: Array<[string, string]> = [
      ['GET', '/api/templates'],
      ['GET', '/api/templates/1'],
      ['GET', '/api/templates/stats'],
      ['GET', '/api/templates/1/stats'],
    ];

    it.each(writeRoutes)('rejects %s %s without templates:write', async (method, path) => {
      const handler = createTemplateAPIHandler({
        templateService: createService() as any,
        resolvePermissions: () => [TEMPLATE_READ_PERMISSION],
      });
      const { statusCode } = await invoke(handler, method, path);
      expect(statusCode).toBe(403);
    });

    it.each(readRoutes)('rejects %s %s without templates:read', async (method, path) => {
      const handler = createTemplateAPIHandler({
        templateService: createService() as any,
        resolvePermissions: () => [TEMPLATE_WRITE_PERMISSION],
      });
      const { statusCode } = await invoke(handler, method, path);
      expect(statusCode).toBe(403);
    });

    it.each(writeRoutes)('allows %s %s with templates:write', async (method, path) => {
      const handler = createTemplateAPIHandler({
        templateService: createService() as any,
        resolvePermissions: () => [TEMPLATE_WRITE_PERMISSION],
      });
      const { statusCode } = await invoke(handler, method, path);
      expect(statusCode).not.toBe(403);
    });

    it.each(readRoutes)('allows %s %s with templates:read', async (method, path) => {
      const handler = createTemplateAPIHandler({
        templateService: createService() as any,
        resolvePermissions: () => [TEMPLATE_READ_PERMISSION],
      });
      const { statusCode } = await invoke(handler, method, path);
      expect(statusCode).not.toBe(403);
    });

    it('rejects all privileged routes when no permission resolver is configured', async () => {
      const handler = createTemplateAPIHandler({ templateService: createService() as any });
      const { statusCode } = await invoke(handler, 'GET', '/api/templates');
      expect(statusCode).toBe(403);
    });
  });
}
