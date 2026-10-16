import http from 'http';
import { createEventsServer } from './events-server';
import { Database } from '../database/database';
import { NotificationTemplateRepository } from '../services/notification-template-repository';
import { NotificationTemplateService } from '../services/notification-template-service';
import { TemplateAuditTrail } from '../services/template-audit-trail';
import { NotificationTemplateCache } from '../services/notification-template-cache';
import { parseTemplateUpdateBody } from './template-api';
import { fingerprintCredential, resolveRequestActor } from '../utils/request-actor';

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    })),
  },
}), { virtual: true });

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

function request(
  server: http.Server,
  method: string,
  path: string,
  options?: {
    body?: object;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const payload = options?.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers ?? {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode!,
          body: data ? JSON.parse(data) : null,
        }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createTemplateService(): Promise<{
  db: Database;
  service: NotificationTemplateService;
}> {
  const db = new Database(':memory:');
  await db.initialize();
  const cache = new NotificationTemplateCache(60, 0);
  const repository = new NotificationTemplateRepository(db, new TemplateAuditTrail(db), cache);
  const service = new NotificationTemplateService(repository, cache);
  return { db, service };
}

describe('Template API endpoints', () => {
  let db: Database;
  let service: NotificationTemplateService;
  let server: http.Server;

  beforeEach(async () => {
    ({ db, service } = await createTemplateService());
    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      templateService: service as any,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    await service.create({
      id: 'welcome-email',
      name: 'Welcome Email',
      type: 'email',
      subject: 'Welcome',
      body: 'Hello {{name}}',
      variables: ['name'],
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await db.close();
  });

  it('PUT /api/templates/:id updates via repository and records actor from x-api-key', async () => {
    const res = await request(server, 'PUT', '/api/templates/welcome-email', {
      headers: { 'x-api-key': 'admin-key-123' },
      body: { body: 'Hello {{name}}, welcome aboard!' },
    });

    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data.body).toBe('Hello {{name}}, welcome aboard!');

    const audit = await service.getAuditHistory('welcome-email');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe(`api-key:${fingerprintCredential('admin-key-123')}`);
    expect(audit[0].actor).not.toContain('admin-key-123');
  });

  it('GET /api/templates/:id/audit returns update history', async () => {
    await request(server, 'PUT', '/api/templates/welcome-email', {
      headers: { Authorization: 'Bearer editor-token' },
      body: { name: 'Welcome Email v2' },
    });

    const res = await request(server, 'GET', '/api/templates/welcome-email/audit');

    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    const data = (res.body as any).data as { templateId: string; records: Array<{ actor: string; action: string }> };
    expect(data.templateId).toBe('welcome-email');
    expect(data.records).toHaveLength(1);
    expect(data.records[0].actor).toBe(`bearer:${fingerprintCredential('editor-token')}`);
    expect(JSON.stringify(res.body)).not.toContain('editor-token');
    expect(data.records[0].action).toBe('UPDATE');
  });

  it('GET /api/templates/:id returns a template through the cache-backed service', async () => {
    const res = await request(server, 'GET', '/api/templates/welcome-email');
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data.id).toBe('welcome-email');
  });

  it('POST /api/templates creates a template', async () => {
    const res = await request(server, 'POST', '/api/templates', {
      body: {
        id: 'digest',
        name: 'Daily Digest',
        type: 'email',
        body: 'Your daily summary',
      },
    });

    expect(res.status).toBe(201);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data.id).toBe('digest');
  });

  it('returns 404 when updating a missing template', async () => {
    const res = await request(server, 'PUT', '/api/templates/missing', {
      headers: { 'x-api-key': 'admin' },
      body: { body: 'Nope' },
    });
    expect(res.status).toBe(404);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for audit history on a missing template', async () => {
    const res = await request(server, 'GET', '/api/templates/missing/audit');
    expect(res.status).toBe(404);
    expect((res.body as any).success).toBe(false);
  });

  it('returns 400 for an empty update body', async () => {
    const res = await request(server, 'PUT', '/api/templates/welcome-email', {
      headers: { 'x-api-key': 'admin' },
      body: {},
    });
    expect(res.status).toBe(400);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe('BAD_REQUEST');
  });

  it('returns 503 when template service is not configured', async () => {
    const disabledServer = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    await new Promise<void>((resolve) => disabledServer.listen(0, '127.0.0.1', () => resolve()));

    const res = await request(disabledServer, 'PUT', '/api/templates/welcome-email', {
      body: { body: 'Blocked' },
    });

    expect(res.status).toBe(503);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.code).toBe('SERVICE_UNAVAILABLE');
    await new Promise<void>((resolve, reject) => disabledServer.close((err) => (err ? reject(err) : resolve())));
  });

  it('GET /api/templates returns all templates', async () => {
    await service.create({ id: 'tmpl-2', name: 'Second', type: 'sms', body: 'Hi {{name}}' });
    const res = await request(server, 'GET', '/api/templates');
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    const body = (res.body as any).data as Array<{ id: string }>;
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body.some((t) => t.id === 'welcome-email')).toBe(true);
    expect(body.some((t) => t.id === 'tmpl-2')).toBe(true);
  });

  it('DELETE /api/templates/:id removes the template', async () => {
    const del = await request(server, 'DELETE', '/api/templates/welcome-email');
    expect(del.status).toBe(200);
    expect((del.body as any).success).toBe(true);

    const get = await request(server, 'GET', '/api/templates/welcome-email');
    expect(get.status).toBe(404);
  });

  it('DELETE /api/templates/:id returns 404 for missing template', async () => {
    const res = await request(server, 'DELETE', '/api/templates/missing');
    expect(res.status).toBe(404);
    expect((res.body as any).success).toBe(false);
  });

  it('POST /api/templates/:id/render substitutes variables', async () => {
    const res = await request(server, 'POST', '/api/templates/welcome-email/render', {
      body: { name: 'Alice' },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    const data = (res.body as any).data as { body: string; subject: string };
    expect(data.body).toBe('Hello Alice');
    expect(data.subject).toBe('Welcome');
  });

  it('POST /api/templates/:id/render returns 422 for missing variables', async () => {
    const res = await request(server, 'POST', '/api/templates/welcome-email/render', {
      body: {},
    });
    expect(res.status).toBe(422);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error.message).toMatch(/missing required variables/i);
  });

  it('POST /api/templates/:id/render returns 404 for missing template', async () => {
    const res = await request(server, 'POST', '/api/templates/missing/render', {
      body: { name: 'Bob' },
    });
    expect(res.status).toBe(404);
    expect((res.body as any).success).toBe(false);
  });
});

describe('template-api helpers', () => {
  it('parseTemplateUpdateBody rejects empty updates', () => {
    expect(() => parseTemplateUpdateBody({})).toThrow('at least one template field');
  });

  it('resolveRequestActor prefers API key identity', () => {
    const actor = resolveRequestActor({
      headers: { 'x-api-key': 'secret' },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as http.IncomingMessage);
    expect(actor).toBe(`api-key:${fingerprintCredential('secret')}`);
    expect(actor).not.toContain('secret');
  });
});
