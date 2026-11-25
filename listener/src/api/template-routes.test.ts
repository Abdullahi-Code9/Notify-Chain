import http from 'http';
import { EventEmitter } from 'events';
import { handleTemplateRoutes } from './template-routes';
import { TemplateService } from '../services/template-service';
import { TemplateChannelType } from '../types/notification-template';

function makeRequest(method: string, url: string, body?: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  (req as http.IncomingMessage & { authPrincipal?: { type: 'legacy'; clientId: string } }).authPrincipal = {
    type: 'legacy',
    clientId: 'test-client',
  };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function makeRawRequest(method: string, url: string, rawBody: string): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  (req as http.IncomingMessage & { authPrincipal?: { type: 'legacy'; clientId: string } }).authPrincipal = {
    type: 'legacy',
    clientId: 'test-client',
  };
  process.nextTick(() => {
    req.emit('data', Buffer.from(rawBody));
    req.emit('end');
  });
  return req;
}

function makeResponse(): http.ServerResponse & { statusCode: number; body: any } {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.body = undefined;
  res.writeHead = jest.fn((status: number) => {
    res.statusCode = status;
    return res;
  });
  res.end = jest.fn((data?: string) => {
    res.body = data ? JSON.parse(data) : undefined;
    return res;
  });
  return res;
}

function makeTemplateService(): jest.Mocked<
  Pick<
    TemplateService,
    | 'createTemplate'
    | 'updateTemplate'
    | 'listTemplates'
    | 'getTemplate'
    | 'renderTemplate'
    | 'deactivateTemplate'
    | 'deleteTemplate'
    | 'getTemplateStats'
    | 'getOverviewStats'
  >
> {
  return {
    createTemplate: jest.fn(),
    updateTemplate: jest.fn(),
    listTemplates: jest.fn().mockResolvedValue([]),
    getTemplate: jest.fn(),
    renderTemplate: jest.fn(),
    deactivateTemplate: jest.fn().mockResolvedValue(true),
    deleteTemplate: jest.fn().mockResolvedValue(true),
    getTemplateStats: jest.fn(),
    getOverviewStats: jest.fn().mockResolvedValue({ totalTemplates: 0 }),
  };
}

describe('template-routes validation', () => {
  let service: ReturnType<typeof makeTemplateService>;

  beforeEach(() => {
    service = makeTemplateService();
  });

  describe('POST /api/templates', () => {
    it('rejects a request missing required fields without calling the service', async () => {
      const req = makeRequest('POST', '/api/templates', { name: 'Only a name' });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'uniqueKey' }),
          expect.objectContaining({ field: 'channelType' }),
          expect.objectContaining({ field: 'bodyTemplate' }),
        ]),
      );
      expect(service.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects an invalid channelType', async () => {
      const req = makeRequest('POST', '/api/templates', {
        uniqueKey: 'k',
        name: 'n',
        channelType: 'CARRIER_PIGEON',
        bodyTemplate: 'body',
      });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(service.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON with a 400, not a 500', async () => {
      const req = makeRawRequest('POST', '/api/templates', '{not valid json');
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Invalid JSON body');
    });

    it('returns 400 when the service reports the template failed validation', async () => {
      service.createTemplate.mockResolvedValue({
        success: false,
        error: 'Template validation failed',
        validation: { isValid: false, errors: ['Body template is required'] },
      });
      const req = makeRequest('POST', '/api/templates', {
        uniqueKey: 'k',
        name: 'n',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'body',
      });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Template validation failed');
    });

    it('returns 201 when the service accepts the template', async () => {
      service.createTemplate.mockResolvedValue({ success: true, templateId: 5 });
      const req = makeRequest('POST', '/api/templates', {
        uniqueKey: 'k',
        name: 'n',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'body',
      });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(201);
      expect(res.body.id).toBe(5);
    });
  });

  describe('GET /api/templates', () => {
    it('rejects an invalid channelType query param', async () => {
      const req = makeRequest('GET', '/api/templates?channelType=NOT_REAL');
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(service.listTemplates).not.toHaveBeenCalled();
    });

    it('accepts a valid channelType query param', async () => {
      const req = makeRequest('GET', '/api/templates?channelType=EMAIL');
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(200);
      expect(service.listTemplates).toHaveBeenCalledWith({
        channelType: TemplateChannelType.EMAIL,
        isActive: undefined,
      });
    });
  });

  describe('PUT /api/templates/:id', () => {
    it('does not route a non-numeric id to the update handler', async () => {
      const req = makeRequest('PUT', '/api/templates/abc', { name: 'New name' });
      const res = makeResponse();

      const handled = await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(handled).toBe(false);
      expect(service.updateTemplate).not.toHaveBeenCalled();
    });

    it('returns 404 when the service reports the template does not exist', async () => {
      service.updateTemplate.mockResolvedValue({ success: false, error: 'Template not found' });
      const req = makeRequest('PUT', '/api/templates/999', { name: 'New name' });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 (not 200) when the service rejects the update', async () => {
      service.updateTemplate.mockResolvedValue({
        success: false,
        error: 'Template validation failed',
        validation: { isValid: false, errors: ['Body template exceeds maximum length'] },
      });
      const req = makeRequest('PUT', '/api/templates/1', { bodyTemplate: 'x'.repeat(20000) });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Template validation failed');
    });

    it('returns 200 when the service accepts the update', async () => {
      service.updateTemplate.mockResolvedValue({ success: true });
      const req = makeRequest('PUT', '/api/templates/1', { name: 'New name' });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/templates/render', () => {
    it('rejects a non-object context', async () => {
      const req = makeRequest('POST', '/api/templates/render', { templateId: 1, context: 'nope' });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(service.renderTemplate).not.toHaveBeenCalled();
    });

    it('rejects a request missing both templateId and uniqueKey', async () => {
      const req = makeRequest('POST', '/api/templates/render', { context: {} });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
    });

    it('surfaces missing variables from the service as a 400', async () => {
      service.renderTemplate.mockResolvedValue({
        success: false,
        error: 'Missing required variables',
        missingVariables: ['name'],
      });
      const req = makeRequest('POST', '/api/templates/render', { templateId: 1, context: {} });
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(res.body.missingVariables).toEqual(['name']);
    });
  });

  describe('GET /api/templates/stats', () => {
    it('rejects a non-numeric templateId query param', async () => {
      const req = makeRequest('GET', '/api/templates/stats?templateId=abc');
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(400);
      expect(service.getTemplateStats).not.toHaveBeenCalled();
    });

    it('falls back to overview stats when no templateId is given', async () => {
      const req = makeRequest('GET', '/api/templates/stats');
      const res = makeResponse();

      await handleTemplateRoutes(req, res, 'req-1', service as unknown as TemplateService);

      expect(res.statusCode).toBe(200);
      expect(service.getOverviewStats).toHaveBeenCalled();
      expect(service.getTemplateStats).not.toHaveBeenCalled();
    });
  });
});
