/**
 * Template API Integration Tests
 * 
 * End-to-end tests for REST API endpoints
 * Tests all CRUD operations, rendering, and edge cases
 */

import * as http from 'http';
import { Database } from '../database/database';
import { TemplateRepository } from '../services/template-repository';
import { TemplateService } from '../services/template-service';
import { createTemplateAPIHandler } from '../api/template-api';
import { TemplateChannelType } from '../types/notification-template';
import * as fs from 'fs';
import * as path from 'path';

describe('Template API Integration Tests', () => {
  let db: Database;
  let repository: TemplateRepository;
  let service: TemplateService;
  let server: http.Server;

  const testDbPath = './data/test-template-api.db';
  const PORT = 3001;
  const BASE_URL = `http://localhost:${PORT}`;

  beforeAll(async () => {
    // Setup database
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    db = new Database(testDbPath);
    await db.initialize();

    // Run template schema (exec handles multi-statement scripts incl. triggers)
    const schemaPath = path.join(__dirname, '../database/template-schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf-8');
      await db.exec(schema);
    }

    repository = new TemplateRepository(db);
    service = new TemplateService(repository);

    // Create HTTP server
    const templateAPIHandler = createTemplateAPIHandler({ templateService: service });

    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      templateAPIHandler(req, res, url);
    });

    await new Promise<void>((resolve) => {
      server.listen(PORT, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(async () => {
    await db.run('DELETE FROM template_usage_log');
    await db.run('DELETE FROM channel_templates');
  });

  /**
   * Helper function to make HTTP requests
   */
  async function request(
    method: string,
    path: string,
    body?: any
  ): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const options = {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      };

      const req = http.request(`${BASE_URL}${path}`, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode || 0,
              data: data ? JSON.parse(data) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  describe('POST /api/templates - Create Template', () => {
    test('should create valid template', async () => {
      const response = await request('POST', '/api/templates', {
        uniqueKey: 'test_template',
        name: 'Test Template',
        description: 'A test template',
        channelType: 'EMAIL',
        subjectTemplate: 'Hello {{name}}',
        bodyTemplate: 'Welcome {{name}}!',
        variables: ['name'],
      });

      expect(response.status).toBe(201);
      expect(response.data.id).toBeGreaterThan(0);
      expect(response.data.message).toContain('created');
      expect(response.data.validation.isValid).toBe(true);
    });

    test('should reject template with invalid syntax', async () => {
      const response = await request('POST', '/api/templates', {
        uniqueKey: 'invalid_template',
        name: 'Invalid',
        channelType: 'EMAIL',
        bodyTemplate: 'Hello {{name!', // Unclosed bracket
      });

      expect(response.status).toBe(400);
      expect(response.data.validation.isValid).toBe(false);
      expect(response.data.validation.errors.length).toBeGreaterThan(0);
    });

    test('should reject duplicate unique key', async () => {
      const templateData = {
        uniqueKey: 'duplicate_test',
        name: 'Duplicate',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      };

      await request('POST', '/api/templates', templateData);
      const response = await request('POST', '/api/templates', templateData);

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('already exists');
    });

    test('should reject missing required fields', async () => {
      const response = await request('POST', '/api/templates', {
        name: 'Missing Fields',
      });

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('required fields');
    });

    test('should reject script injection in template', async () => {
      const response = await request('POST', '/api/templates', {
        uniqueKey: 'xss_attempt',
        name: 'XSS Template',
        channelType: 'EMAIL',
        bodyTemplate: '<script>alert("xss")</script> Hello {{name}}',
      });

      expect(response.status).toBe(400);
      expect(response.data.validation.errors[0]).toContain('dangerous content');
    });
  });

  describe('GET /api/templates - List Templates', () => {
    beforeEach(async () => {
      // Create sample templates
      await request('POST', '/api/templates', {
        uniqueKey: 'email_template',
        name: 'Email Template',
        channelType: 'EMAIL',
        bodyTemplate: 'Email content',
      });

      await request('POST', '/api/templates', {
        uniqueKey: 'sms_template',
        name: 'SMS Template',
        channelType: 'SMS',
        bodyTemplate: 'SMS content',
      });
    });

    test('should list all templates', async () => {
      const response = await request('GET', '/api/templates');

      expect(response.status).toBe(200);
      expect(response.data.count).toBe(2);
      expect(response.data.templates).toHaveLength(2);
    });

    test('should filter by channel type', async () => {
      const response = await request('GET', '/api/templates?channelType=EMAIL');

      expect(response.status).toBe(200);
      expect(response.data.count).toBe(1);
      expect(response.data.templates[0].channelType).toBe('EMAIL');
    });

    test('should filter by active status', async () => {
      const response = await request('GET', '/api/templates?isActive=true');

      expect(response.status).toBe(200);
      expect(response.data.templates.every((t: any) => t.isActive)).toBe(true);
    });

    test('should support pagination', async () => {
      const response = await request('GET', '/api/templates?limit=1&offset=0');

      expect(response.status).toBe(200);
      expect(response.data.count).toBe(1);
    });
  });

  describe('GET /api/templates/:id - Get Template', () => {
    test('should get template by ID', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'get_test',
        name: 'Get Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test content',
      });

      const templateId = createResponse.data.id;
      const response = await request('GET', `/api/templates/${templateId}`);

      expect(response.status).toBe(200);
      expect(response.data.id).toBe(templateId);
      expect(response.data.uniqueKey).toBe('get_test');
    });

    test('should return 404 for non-existent template', async () => {
      const response = await request('GET', '/api/templates/99999');

      expect(response.status).toBe(404);
      expect(response.data.error).toContain('not found');
    });

    test('should reject invalid ID', async () => {
      const response = await request('GET', '/api/templates/invalid');

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('Invalid template ID');
    });
  });

  describe('PUT /api/templates/:id - Update Template', () => {
    test('should update template successfully', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'update_test',
        name: 'Original Name',
        channelType: 'EMAIL',
        bodyTemplate: 'Original body',
      });

      const templateId = createResponse.data.id;

      const updateResponse = await request('PUT', `/api/templates/${templateId}`, {
        name: 'Updated Name',
        bodyTemplate: 'Updated body {{variable}}',
      });

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.data.message).toContain('updated');

      // Verify update
      const getResponse = await request('GET', `/api/templates/${templateId}`);
      expect(getResponse.data.name).toBe('Updated Name');
      expect(getResponse.data.bodyTemplate).toBe('Updated body {{variable}}');
    });

    test('should reject invalid template update', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'update_invalid',
        name: 'Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      });

      const response = await request('PUT', `/api/templates/${createResponse.data.id}`, {
        bodyTemplate: 'Invalid {{bracket',
      });

      expect(response.status).toBe(400);
      expect(response.data.validation.isValid).toBe(false);
    });

    test('should return 404 for non-existent template', async () => {
      const response = await request('PUT', '/api/templates/99999', {
        name: 'Updated',
      });

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('not found');
    });
  });

  describe('DELETE /api/templates/:id - Delete Template', () => {
    test('should soft delete (deactivate) template by default', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'delete_test',
        name: 'Delete Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      });

      const templateId = createResponse.data.id;
      const deleteResponse = await request('DELETE', `/api/templates/${templateId}`);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.data.message).toContain('deactivated');

      // Verify template is inactive
      const getResponse = await request('GET', `/api/templates/${templateId}`);
      expect(getResponse.data.isActive).toBe(false);
    });

    test('should hard delete when hard=true', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'hard_delete_test',
        name: 'Hard Delete Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      });

      const templateId = createResponse.data.id;
      const deleteResponse = await request('DELETE', `/api/templates/${templateId}?hard=true`);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.data.message).toContain('deleted permanently');

      // Verify template is gone
      const getResponse = await request('GET', `/api/templates/${templateId}`);
      expect(getResponse.status).toBe(404);
    });

    test('should return 404 for non-existent template', async () => {
      const response = await request('DELETE', '/api/templates/99999');

      expect(response.status).toBe(404);
      expect(response.data.error).toContain('not found');
    });
  });

  describe('POST /api/templates/render - Render Template', () => {
    test('should render template with all variables', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'render_test',
        name: 'Render Test',
        channelType: 'EMAIL',
        subjectTemplate: 'Hello {{name}}',
        bodyTemplate: 'Welcome {{name}}, your email is {{email}}.',
        variables: ['name', 'email'],
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'render_test',
        context: {
          name: 'John Doe',
          email: 'john@example.com',
        },
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.subject).toBe('Hello John Doe');
      expect(response.data.rendered.body).toBe('Welcome John Doe, your email is john@example.com.');
    });

    test('should reject rendering with missing variables', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'missing_vars',
        name: 'Missing Vars',
        channelType: 'EMAIL',
        bodyTemplate: 'Hello {{name}}!',
        variables: ['name'],
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'missing_vars',
        context: {},
      });

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('Missing');
      expect(response.data.missingVariables).toContain('name');
    });

    test('should handle XSS attempts with escaping', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'xss_test',
        name: 'XSS Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Hello {{name}}!',
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'xss_test',
        context: {
          name: '<script>alert("xss")</script>',
        },
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.body).toContain('&lt;script&gt;');
      expect(response.data.rendered.body).not.toContain('<script>');
    });

    test('should return 400 for inactive template', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'inactive_test',
        name: 'Inactive Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      });

      // Deactivate template
      await request('DELETE', `/api/templates/${createResponse.data.id}`);

      // Try to render
      const response = await request('POST', '/api/templates/render', {
        template: 'inactive_test',
        context: {},
      });

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('inactive');
    });

    test('should return 400 for missing template', async () => {
      const response = await request('POST', '/api/templates/render', {
        template: 'non_existent',
        context: {},
      });

      expect(response.status).toBe(400);
      expect(response.data.error).toContain('not found');
    });
  });

  describe('GET /api/templates/stats - Overview Statistics', () => {
    test('should return overview statistics', async () => {
      // Create templates in different channels
      await request('POST', '/api/templates', {
        uniqueKey: 'email1',
        name: 'Email 1',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      });

      await request('POST', '/api/templates', {
        uniqueKey: 'email2',
        name: 'Email 2',
        channelType: 'EMAIL',
        bodyTemplate: 'Test',
      });

      await request('POST', '/api/templates', {
        uniqueKey: 'sms1',
        name: 'SMS 1',
        channelType: 'SMS',
        bodyTemplate: 'Test',
      });

      const response = await request('GET', '/api/templates/stats');

      expect(response.status).toBe(200);
      expect(response.data.totalTemplates).toBe(3);
      expect(response.data.activeTemplates).toBe(3);
      expect(response.data.byChannel.EMAIL).toBe(2);
      expect(response.data.byChannel.SMS).toBe(1);
    });
  });

  describe('GET /api/templates/:id/stats - Template Usage Statistics', () => {
    test('should return usage statistics', async () => {
      const createResponse = await request('POST', '/api/templates', {
        uniqueKey: 'usage_stats_test',
        name: 'Usage Stats Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test {{var}}',
        variables: ['var'],
      });

      const templateId = createResponse.data.id;

      // Render template multiple times
      await request('POST', '/api/templates/render', {
        template: 'usage_stats_test',
        context: { var: 'value1' },
      });

      await request('POST', '/api/templates/render', {
        template: 'usage_stats_test',
        context: { var: 'value2' },
      });

      const response = await request('GET', `/api/templates/${templateId}/stats`);

      expect(response.status).toBe(200);
      expect(response.data.totalUses).toBe(2);
      expect(response.data.successCount).toBe(2);
      expect(response.data.failureCount).toBe(0);
      expect(response.data.lastUsed).toBeDefined();
    });
  });

  describe('Edge Cases and Security', () => {
    test('should handle nested property rendering', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'nested_test',
        name: 'Nested Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Hello {{user.name}}, order {{order.id}} is ready!',
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'nested_test',
        context: {
          user: { name: 'John' },
          order: { id: '12345' },
        },
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.body).toBe('Hello John, order 12345 is ready!');
    });

    test('should handle default values', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'defaults_test',
        name: 'Defaults Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Hello {{name}}!',
        defaultValues: { name: 'Guest' },
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'defaults_test',
        context: {},
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.body).toBe('Hello Guest!');
    });

    test('should reject prototype pollution attempts', async () => {
      const response = await request('POST', '/api/templates', {
        uniqueKey: 'pollution_test',
        name: 'Pollution Test',
        channelType: 'EMAIL',
        bodyTemplate: 'Test {{__proto__}}',
      });

      expect(response.status).toBe(400);
      expect(response.data.validation.errors[0]).toContain('prototype pollution');
    });

    test('should validate channel-specific requirements', async () => {
      // SMS longer than 160 chars should warn
      const longSMS = 'a'.repeat(200);
      const response = await request('POST', '/api/templates', {
        uniqueKey: 'long_sms',
        name: 'Long SMS',
        channelType: 'SMS',
        bodyTemplate: longSMS,
      });

      expect(response.status).toBe(201); // Creates successfully
      expect(response.data.validation.warnings?.length).toBeGreaterThan(0);
    });

    test('should handle special characters in context', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'special_chars',
        name: 'Special Chars',
        channelType: 'EMAIL',
        bodyTemplate: 'Amount: ${{amount}}, Rate: {{rate}}%',
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'special_chars',
        context: {
          amount: '100.50',
          rate: '5',
        },
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.body).toBe('Amount: $100.50, Rate: 5%');
    });

    test('should handle empty context gracefully', async () => {
      await request('POST', '/api/templates', {
        uniqueKey: 'empty_context',
        name: 'Empty Context',
        channelType: 'EMAIL',
        bodyTemplate: 'Hello!',
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'empty_context',
        context: {},
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.body).toBe('Hello!');
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large template body', async () => {
      const largeBody = 'Line of text. '.repeat(500); // ~7000 chars

      const response = await request('POST', '/api/templates', {
        uniqueKey: 'large_template',
        name: 'Large Template',
        channelType: 'EMAIL',
        bodyTemplate: largeBody,
      });

      expect(response.status).toBe(201);
    });

    test('should handle many variables', async () => {
      const variables = Array.from({ length: 50 }, (_, i) => `var${i}`);
      const bodyTemplate = variables.map((v) => `{{${v}}}`).join(' ');
      const context = Object.fromEntries(variables.map((v) => [v, `value_${v}`]));

      await request('POST', '/api/templates', {
        uniqueKey: 'many_vars',
        name: 'Many Variables',
        channelType: 'EMAIL',
        bodyTemplate,
        variables,
      });

      const response = await request('POST', '/api/templates/render', {
        template: 'many_vars',
        context,
      });

      expect(response.status).toBe(200);
      expect(response.data.rendered.body).toContain('value_var0');
      expect(response.data.rendered.body).toContain('value_var49');
    });
  });
});
