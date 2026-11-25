/**
 * Notification Template System Tests
 * 
 * Tests for template rendering, validation, and CRUD operations
 */

import { Database } from '../database/database';
import { TemplateRepository } from '../services/template-repository';
import { TemplateService } from '../services/template-service';
import { TemplateRenderer } from '../services/template-renderer';
import { TemplateValidator } from '../services/template-validator';
import { TemplateChannelType } from '../types/notification-template';
import * as fs from 'fs';
import * as path from 'path';

describe('Notification Template System', () => {
  let db: Database;
  let repository: TemplateRepository;
  let service: TemplateService;

  const testDbPath = './data/test-templates.db';

  beforeAll(async () => {
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
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    await db.exec(schema);

    repository = new TemplateRepository(db);
    service = new TemplateService(repository);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(async () => {
    await db.run('DELETE FROM template_usage_log');
    await db.run('DELETE FROM channel_templates');
  });

  describe('TemplateRenderer', () => {
    test('should render simple variable', () => {
      const template = 'Hello {{name}}!';
      const context = { name: 'John' };

      const result = TemplateRenderer.render(template, context);
      expect(result).toBe('Hello John!');
    });

    test('should render multiple variables', () => {
      const template = 'Hello {{first_name}} {{last_name}}!';
      const context = { first_name: 'John', last_name: 'Doe' };

      const result = TemplateRenderer.render(template, context);
      expect(result).toBe('Hello John Doe!');
    });

    test('should render nested properties', () => {
      const template = 'Hello {{user.name}}!';
      const context = { user: { name: 'John' } };

      const result = TemplateRenderer.render(template, context);
      expect(result).toBe('Hello John!');
    });

    test('should handle missing variables gracefully', () => {
      const template = 'Hello {{name}}!';
      const context = {};

      const result = TemplateRenderer.render(template, context);
      expect(result).toBe('Hello !');
    });

    test('should escape HTML by default', () => {
      const template = 'Hello {{name}}!';
      const context = { name: '<script>alert("xss")</script>' };

      const result = TemplateRenderer.render(template, context);
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('<script>');
    });

    test('should throw in strict mode for missing variables', () => {
      const template = 'Hello {{name}}!';
      const context = {};

      expect(() => {
        TemplateRenderer.render(template, context, { strictMode: true });
      }).toThrow('Missing required variable: name');
    });

    test('should extract variables from template', () => {
      const template = 'Hello {{first_name}} {{last_name}}! Your email is {{email}}.';
      const variables = TemplateRenderer.extractVariables(template);

      expect(variables).toEqual(['first_name', 'last_name', 'email']);
    });

    test('should use default values', () => {
      const template = 'Hello {{name}}!';
      const context = {};
      const defaultValues = { name: 'Guest' };

      const result = TemplateRenderer.renderTemplate(undefined, template, context, defaultValues);
      expect(result.body).toBe('Hello Guest!');
    });

    test('should validate context', () => {
      const requiredVariables = ['name', 'email'];
      const context = { name: 'John' };

      const validation = TemplateRenderer.validateContext(requiredVariables, context);
      expect(validation.valid).toBe(false);
      expect(validation.missing).toEqual(['email']);
    });
  });

  describe('TemplateValidator', () => {
    test('should validate correct template', () => {
      const template = 'Hello {{name}}!';
      const result = TemplateValidator.validate(template);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should detect unclosed brackets', () => {
      const template = 'Hello {{name!';
      const result = TemplateValidator.validate(template);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Mismatched brackets');
    });

    test('should reject empty variable', () => {
      const template = 'Hello {{}}!';
      const result = TemplateValidator.validate(template);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Empty variable');
    });

    test('should reject invalid variable name', () => {
      const template = 'Hello {{user-name}}!';
      const result = TemplateValidator.validate(template);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Invalid variable name');
    });

    test('should detect script injection', () => {
      const template = '<script>alert("xss")</script> Hello {{name}}!';
      const result = TemplateValidator.validate(template);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('dangerous content');
    });

    test('should validate unique key format', () => {
      const valid = TemplateValidator.validateUniqueKey('welcome_email');
      expect(valid.valid).toBe(true);

      const invalid = TemplateValidator.validateUniqueKey('Welcome Email');
      expect(invalid.valid).toBe(false);
    });

    test('should validate channel-specific requirements', () => {
      const longSMS = 'a'.repeat(200);
      const result = TemplateValidator.validate(longSMS, undefined, TemplateChannelType.SMS);

      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toContain('160 characters');
    });
  });

  describe('TemplateService - CRUD Operations', () => {
    test('should create template successfully', async () => {
      const input = {
        uniqueKey: 'test_template',
        name: 'Test Template',
        description: 'A test template',
        channelType: TemplateChannelType.EMAIL,
        subjectTemplate: 'Hello {{name}}',
        bodyTemplate: 'Welcome {{name}}!',
        variables: ['name'],
        defaultValues: { name: 'User' },
      };

      const result = await service.createTemplate(input);

      expect(result.success).toBe(true);
      expect(result.templateId).toBeGreaterThan(0);
      expect(result.validation?.isValid).toBe(true);
    });

    test('should reject invalid template', async () => {
      const input = {
        uniqueKey: 'invalid_template',
        name: 'Invalid Template',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Hello {{name!',  // Unclosed bracket
      };

      const result = await service.createTemplate(input);

      expect(result.success).toBe(false);
      expect(result.validation?.isValid).toBe(false);
    });

    test('should reject duplicate unique key', async () => {
      const input = {
        uniqueKey: 'duplicate_template',
        name: 'Template',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Test',
      };

      await service.createTemplate(input);
      const result = await service.createTemplate(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    test('should update template', async () => {
      const createResult = await service.createTemplate({
        uniqueKey: 'update_test',
        name: 'Original Name',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Original body',
      });

      const updateResult = await service.updateTemplate(createResult.templateId!, {
        name: 'Updated Name',
        bodyTemplate: 'Updated body {{name}}',
      });

      expect(updateResult.success).toBe(true);

      const template = await service.getTemplate(createResult.templateId!);
      expect(template?.name).toBe('Updated Name');
      expect(template?.bodyTemplate).toBe('Updated body {{name}}');
    });

    test('should list templates with filters', async () => {
      await service.createTemplate({
        uniqueKey: 'email_template',
        name: 'Email',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Test',
      });

      await service.createTemplate({
        uniqueKey: 'sms_template',
        name: 'SMS',
        channelType: TemplateChannelType.SMS,
        bodyTemplate: 'Test',
      });

      const emailTemplates = await service.listTemplates({
        channelType: TemplateChannelType.EMAIL,
      });

      expect(emailTemplates).toHaveLength(1);
      expect(emailTemplates[0].channelType).toBe(TemplateChannelType.EMAIL);
    });

    test('should deactivate template', async () => {
      const createResult = await service.createTemplate({
        uniqueKey: 'deactivate_test',
        name: 'Test',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Test',
      });

      const success = await service.deactivateTemplate(createResult.templateId!);
      expect(success).toBe(true);

      const template = await service.getTemplate(createResult.templateId!);
      expect(template?.isActive).toBe(false);
    });
  });

  describe('Template Rendering Integration', () => {
    test('should render template via service', async () => {
      const createResult = await service.createTemplate({
        uniqueKey: 'render_test',
        name: 'Render Test',
        channelType: TemplateChannelType.EMAIL,
        subjectTemplate: 'Hello {{name}}',
        bodyTemplate: 'Welcome {{name}}! Your email is {{email}}.',
        variables: ['name', 'email'],
      });

      const renderResult = await service.renderTemplate('render_test', {
        name: 'John',
        email: 'john@example.com',
      });

      expect(renderResult.success).toBe(true);
      expect(renderResult.rendered?.subject).toBe('Hello John');
      expect(renderResult.rendered?.body).toBe('Welcome John! Your email is john@example.com.');
    });

    test('should reject rendering with missing variables', async () => {
      await service.createTemplate({
        uniqueKey: 'missing_vars_test',
        name: 'Test',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Hello {{name}}!',
        variables: ['name'],
      });

      const renderResult = await service.renderTemplate('missing_vars_test', {});

      expect(renderResult.success).toBe(false);
      expect(renderResult.missingVariables).toContain('name');
    });

    test('should log template usage', async () => {
      const createResult = await service.createTemplate({
        uniqueKey: 'usage_test',
        name: 'Usage Test',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Test',
      });

      await service.renderTemplate('usage_test', {});

      const stats = await service.getTemplateStats(createResult.templateId!);
      expect(stats.totalUses).toBe(1);
      expect(stats.successCount).toBe(1);
    });
  });

  describe('Security Tests', () => {
    test('should prevent XSS via HTML escaping', async () => {
      const createResult = await service.createTemplate({
        uniqueKey: 'xss_test',
        name: 'XSS Test',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: 'Hello {{name}}!',
      });

      const renderResult = await service.renderTemplate('xss_test', {
        name: '<script>alert("xss")</script>',
      });

      expect(renderResult.rendered?.body).toContain('&lt;script&gt;');
      expect(renderResult.rendered?.body).not.toContain('<script>');
    });

    test('should reject script tags in template', async () => {
      const result = await service.createTemplate({
        uniqueKey: 'script_test',
        name: 'Script Test',
        channelType: TemplateChannelType.EMAIL,
        bodyTemplate: '<script>alert("xss")</script> Hello {{name}}!',
      });

      expect(result.success).toBe(false);
      expect(result.validation?.errors[0]).toContain('dangerous content');
    });

    test('should prevent prototype pollution', () => {
      const template = 'Test {{__proto__}}';
      const result = TemplateValidator.validate(template);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('prototype pollution');
    });
  });
});
