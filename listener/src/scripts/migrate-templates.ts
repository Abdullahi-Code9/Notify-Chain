#!/usr/bin/env ts-node
/**
 * Template Database Migration Script
 * 
 * Run this to initialize or update the template database schema
 * 
 * Usage:
 *   npm run migrate:templates
 *   or
 *   ts-node src/scripts/migrate-templates.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import logger from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

async function migrateTemplates() {
  const dbPath = process.env.DATABASE_PATH || './data/notifications.db';

  try {
    logger.info('Starting template database migration...', { dbPath });

    // Ensure data directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true});
      logger.info('Created database directory', { path: dbDir });
    }

    // Initialize database connection
    const db = new Database(dbPath);
    await db.initialize();

    // Read template schema
    const schemaPath = path.join(__dirname, '../database/template-schema.sql');

    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Template schema file not found: ${schemaPath}`);
    }

    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // exec runs the whole script so the CREATE TRIGGER ... BEGIN/END block works
    await db.exec(schema);

    logger.info('Template schema migration completed');

    // Verify tables exist
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%template%' ORDER BY name"
    );

    logger.info('Template tables created:', { tables: tables.map((t) => t.name) });

    // Create sample templates (optional)
    await createSampleTemplates(db);

    await db.close();
    logger.info('Template database migration successful! ✅');
    process.exit(0);
  } catch (error) {
    logger.error('Template database migration failed', { error });
    process.exit(1);
  }
}

/**
 * Create sample templates for testing
 */
async function createSampleTemplates(db: Database) {
  try {
    // Check if templates already exist
    const existing = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM channel_templates'
    );

    if ((existing?.count || 0) > 0) {
      logger.info('Sample templates already exist, skipping...');
      return;
    }

    logger.info('Creating sample templates...');

    const samples = [
      {
        uniqueKey: 'welcome_email',
        name: 'Welcome Email',
        description: 'Welcome email sent to new users',
        channelType: 'EMAIL',
        subjectTemplate: 'Welcome to NotifyChain, {{user_name}}!',
        bodyTemplate: `Hello {{user_name}},

Welcome to NotifyChain! We're excited to have you on board.

Your account has been successfully created with email: {{user_email}}

Get started by exploring our features and setting up your first notification.

Best regards,
The NotifyChain Team`,
        variables: JSON.stringify(['user_name', 'user_email']),
        defaultValues: JSON.stringify({ user_name: 'User' }),
      },
      {
        uniqueKey: 'task_completed_discord',
        name: 'Task Completed Notification',
        description: 'Discord notification when a task is completed',
        channelType: 'DISCORD',
        subjectTemplate: null,
        bodyTemplate: `🎉 Task Completed!

**Task:** {{task_title}}
**Completed by:** {{user_name}}
**Reward:** {{reward_amount}} XLM

Status: ✅ Approved`,
        variables: JSON.stringify(['task_title', 'user_name', 'reward_amount']),
        defaultValues: JSON.stringify({ reward_amount: '0' }),
      },
      {
        uniqueKey: 'payment_reminder_sms',
        name: 'Payment Reminder SMS',
        description: 'SMS reminder for pending payments',
        channelType: 'SMS',
        subjectTemplate: null,
        bodyTemplate: 'Hi {{user_name}}, you have a pending payment of {{amount}} due on {{due_date}}. Please complete it soon.',
        variables: JSON.stringify(['user_name', 'amount', 'due_date']),
        defaultValues: JSON.stringify({ user_name: 'User' }),
      },
    ];

    for (const sample of samples) {
      await db.run(
        `INSERT INTO channel_templates (
          unique_key, name, description, channel_type,
          subject_template, body_template, variables, default_values,
          is_active, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'system')`,
        [
          sample.uniqueKey,
          sample.name,
          sample.description,
          sample.channelType,
          sample.subjectTemplate,
          sample.bodyTemplate,
          sample.variables,
          sample.defaultValues,
        ]
      );
    }

    logger.info('Sample templates created successfully', { count: samples.length });
  } catch (error) {
    logger.warn('Could not create sample templates', { error });
  }
}

// Run migration
migrateTemplates();
