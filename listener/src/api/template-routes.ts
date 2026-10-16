/**
 * Template API Route Handlers
 * Provides HTTP request handlers for template CRUD operations
 */

import http from 'http';
import { TemplateService } from '../services/template-service';
import logger from '../utils/logger';
import { TemplateChannelType } from '../types/notification-template';
import {
  InputValidator,
  ValidationError,
  isNonEmptyString,
  isOneOf,
  isPlainObject,
  isPositiveInteger,
  validationErrorBody,
} from '../utils/validation';
import { sendOk, sendErr, ErrorCode } from '../utils/response';
import { validateContentType } from '../middleware/content-type';

interface TemplateRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  templateService: any;
}

/**
 * Parse request body as JSON
 */
async function parseBody(req: http.IncomingMessage): Promise<any> {
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
 * Send JSON response
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Maps a caught error to a meaningful HTTP response. Input-shape problems
 * (bad JSON, failed validation) become 400s with the specific reason;
 * anything else falls back to a generic 500 rather than leaking internals.
 */
function respondWithError(
  res: http.ServerResponse,
  error: unknown,
  options: { notFoundMessage?: string } = {},
): void {
  if (error instanceof ValidationError) {
    sendJson(res, 400, validationErrorBody(error));
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  if (errorMessage === 'Invalid JSON body') {
    sendJson(res, 400, { error: errorMessage });
    return;
  }

  const lower = errorMessage.toLowerCase();
  if (lower.includes('not found')) {
    sendJson(res, 404, { error: options.notFoundMessage ?? errorMessage });
    return;
  }
  if (lower.includes('unique constraint')) {
    sendJson(res, 409, { error: 'Template with this unique key already exists' });
    return;
  }
  if (lower.includes('validation') || lower.includes('invalid') || lower.includes('required')) {
    sendJson(res, 400, { error: errorMessage });
    return;
  }
  sendJson(res, 500, { error: 'Internal server error' });
}

/**
 * Handle POST /api/templates - Create template
 */
export async function handleCreateTemplate(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  if (!validateContentType(req, res, ['application/json'])) {
    return;
  }

  try {
    const body = await parseBody(req);

    // Validate required fields are present and are strings before handing off to the service
    const v = new InputValidator();
    v.check(
      isNonEmptyString(body.uniqueKey),
      'uniqueKey',
      'is required and must be a non-empty string',
    );
    v.check(isNonEmptyString(body.name), 'name', 'is required and must be a non-empty string');
    v.check(
      isOneOf(body.channelType, Object.values(TemplateChannelType)),
      'channelType',
      `must be one of: ${Object.values(TemplateChannelType).join(', ')}`,
    );
    v.check(
      isNonEmptyString(body.bodyTemplate),
      'bodyTemplate',
      'is required and must be a non-empty string',
    );
    v.throwIfInvalid();

    const result = await templateService.createTemplate({
      uniqueKey: body.uniqueKey,
      name: body.name,
      description: body.description,
      channelType: body.channelType,
      subjectTemplate: body.subjectTemplate,
      bodyTemplate: body.bodyTemplate,
      variables: body.variables || [],
      defaultValues: body.defaultValues || {},
      createdBy: body.createdBy,
    });

    if (!result.success) {
      sendJson(res, 400, { error: result.error, validation: result.validation });
      logger.warn('Template creation rejected', {
        requestId,
        uniqueKey: body.uniqueKey,
        error: result.error,
      });
      return;
    }

    sendJson(res, 201, {
      id: result.templateId,
      uniqueKey: body.uniqueKey,
      validation: result.validation,
    });

    logger.info('Template created via API', {
      requestId,
      templateId: result.templateId,
      uniqueKey: body.uniqueKey,
    });
  } catch (error) {
    logger.error('Failed to create template', { error, requestId });
    respondWithError(res, error);
  }
}

/**
 * Handle GET /api/templates - List templates
 */
export async function handleListTemplates(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  try {
    const url = new URL(req.url!, 'http://localhost');
    const channelTypeParam = url.searchParams.get('channelType') || undefined;
    if (
      channelTypeParam !== undefined &&
      !isOneOf(channelTypeParam, Object.values(TemplateChannelType))
    ) {
      throw new ValidationError({
        field: 'channelType',
        message: `must be one of: ${Object.values(TemplateChannelType).join(', ')}`,
      });
    }
    const channelType = channelTypeParam as TemplateChannelType | undefined;
    const activeOnly = url.searchParams.get('activeOnly') === 'true';

    const templates = await templateService.listTemplates({
      channelType,
      isActive: activeOnly || undefined,
    });

    sendOk(res, 200, { count: templates.length, templates });
    logger.info('Listed templates via API', {
      requestId,
      count: templates.length,
      channelType,
      activeOnly,
    });
  } catch (error) {
    logger.error('Failed to list templates', { error, requestId });
    respondWithError(res, error);
  }
}

/**
 * Handle GET /api/templates/:id - Get template by ID
 */
export async function handleGetTemplate(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  try {
    const id = parseInt(req.url!.split('/').pop() || '', 10);
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
    logger.info('Retrieved template via API', { requestId, templateId: id });
  } catch (error) {
    logger.error('Failed to get template', { error, requestId });
    respondWithError(res, error);
  }
}

/**
 * Handle GET /api/templates/by-key/:uniqueKey - Get template by unique key
 */
export async function handleGetTemplateByKey(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  try {
    const uniqueKey = req.url!.split('/').pop();
    if (!uniqueKey) {
      sendErr(res, 400, 'Missing unique key', ErrorCode.BAD_REQUEST);
      return;
    }

    const template = await templateService.getTemplate(uniqueKey);
    if (!template) {
      sendErr(res, 404, 'Template not found', ErrorCode.NOT_FOUND);
      return;
    }

    sendOk(res, 200, template);
    logger.info('Retrieved template by key via API', { requestId, uniqueKey });
  } catch (error) {
    logger.error('Failed to get template by key', { error, requestId });
    respondWithError(res, error);
  }
}

/**
 * Handle PUT /api/templates/:id - Update template
 */
export async function handleUpdateTemplate(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  if (!validateContentType(req, res, ['application/json'])) {
    return;
  }

  try {
    const id = parseInt(req.url!.split('/').pop() || '', 10);
    if (isNaN(id)) {
      sendErr(res, 400, 'Invalid template ID', ErrorCode.BAD_REQUEST);
      return;
    }

    const body = await parseBody(req);

    const result = await templateService.updateTemplate(id, body);

    if (!result.success) {
      const status = result.error === 'Template not found' ? 404 : 400;
      sendJson(res, status, { error: result.error, validation: result.validation });
      logger.warn('Template update rejected', { requestId, templateId: id, error: result.error });
      return;
    }

    sendJson(res, 200, {
      id,
      message: 'Template updated successfully',
      validation: result.validation,
    });
    logger.info('Updated template via API', { requestId, templateId: id });
  } catch (error) {
    logger.error('Failed to update template', { error, requestId });
    respondWithError(res, error, { notFoundMessage: 'Template not found' });
  }
}

/**
 * Handle DELETE /api/templates/:id - Delete/deactivate template
 */
export async function handleDeleteTemplate(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  try {
    const url = new URL(req.url!, 'http://localhost');
    const id = parseInt(url.pathname.split('/').pop() || '', 10);
    if (isNaN(id)) {
      sendErr(res, 400, 'Invalid template ID', ErrorCode.BAD_REQUEST);
      return;
    }

    const hardDelete = url.searchParams.get('hard') === 'true';

    if (hardDelete) {
      await templateService.deleteTemplate(id);
    } else {
      await templateService.deactivateTemplate(id);
    }

    sendOk(res, 200, {
      id,
      message: hardDelete ? 'Template deleted permanently' : 'Template deactivated',
    });
    logger.info('Deleted/deactivated template via API', { requestId, templateId: id, hardDelete });
  } catch (error) {
    logger.error('Failed to delete template', { error, requestId });
    respondWithError(res, error, { notFoundMessage: 'Template not found' });
  }
}

/**
 * Handle POST /api/templates/render - Render template
 */
export async function handleRenderTemplate(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  if (!validateContentType(req, res, ['application/json'])) {
    return;
  }

  try {
    const body = await parseBody(req);

    // Validate required fields
    if ((!body.templateId && !body.uniqueKey) || !isPlainObject(body.context)) {
      sendJson(res, 400, {
        error: 'Missing or invalid required fields',
        required: ['templateId OR uniqueKey', 'context (must be an object)'],
      });
      return;
    }

    const result = body.templateId
      ? await templateService.renderTemplate(body.templateId, body.context)
      : await templateService.renderTemplate(body.uniqueKey, body.context);

    if (!result.success) {
      sendJson(res, 400, { error: result.error, missingVariables: result.missingVariables });
      logger.warn('Template render rejected', {
        requestId,
        templateId: body.templateId,
        uniqueKey: body.uniqueKey,
        error: result.error,
      });
      return;
    }

    sendJson(res, 200, result.rendered);

    logger.info('Rendered template via API', {
      requestId,
      templateId: body.templateId,
      uniqueKey: body.uniqueKey,
    });
  } catch (error) {
    logger.error('Failed to render template', { error, requestId });
    respondWithError(res, error, { notFoundMessage: 'Template not found' });
  }
}

/**
 * Handle GET /api/templates/stats - Get template statistics
 */
export async function handleGetTemplateStats(ctx: TemplateRouteContext): Promise<void> {
  const { req, res, requestId, templateService } = ctx;

  try {
    const url = new URL(req.url!, 'http://localhost');
    const idParam = url.searchParams.get('templateId');
    let templateId: number | undefined;
    if (idParam !== null) {
      const parsed = parseInt(idParam, 10);
      if (!isPositiveInteger(parsed)) {
        sendJson(res, 400, { error: 'templateId must be a positive integer' });
        return;
      }
      templateId = parsed;
    }

    const stats =
      templateId !== undefined
        ? await templateService.getTemplateStats(templateId)
        : await templateService.getOverviewStats();

    sendJson(res, 200, stats);

    logger.info('Retrieved template stats via API', { requestId, templateId });
  } catch (error) {
    logger.error('Failed to get template stats', { error, requestId });
    respondWithError(res, error);
  }
}

/**
 * Route template requests to appropriate handlers
 */
export async function handleTemplateRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  templateService: TemplateService,
): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || 'GET';

  const ctx: TemplateRouteContext = { req, res, requestId, templateService };

  // POST /api/templates - Create template
  if (method === 'POST' && url === '/api/templates') {
    await handleCreateTemplate(ctx);
    return true;
  }

  // GET /api/templates - List templates
  if (method === 'GET' && url.startsWith('/api/templates') && url.split('/').length === 3) {
    await handleListTemplates(ctx);
    return true;
  }

  // POST /api/templates/render - Render template
  if (method === 'POST' && url === '/api/templates/render') {
    await handleRenderTemplate(ctx);
    return true;
  }

  // GET /api/templates/stats - Get statistics
  if (method === 'GET' && url.startsWith('/api/templates/stats')) {
    await handleGetTemplateStats(ctx);
    return true;
  }

  // GET /api/templates/by-key/:uniqueKey - Get by unique key
  if (method === 'GET' && url.match(/^\/api\/templates\/by-key\/.+/)) {
    await handleGetTemplateByKey(ctx);
    return true;
  }

  // GET /api/templates/:id - Get template by ID
  if (method === 'GET' && url.match(/^\/api\/templates\/\d+$/)) {
    await handleGetTemplate(ctx);
    return true;
  }

  // PUT /api/templates/:id - Update template
  if (method === 'PUT' && url.match(/^\/api\/templates\/\d+$/)) {
    await handleUpdateTemplate(ctx);
    return true;
  }

  // DELETE /api/templates/:id - Delete template
  if (method === 'DELETE' && url.match(/^\/api\/templates\/\d+/)) {
    await handleDeleteTemplate(ctx);
    return true;
  }

  return false;
}
