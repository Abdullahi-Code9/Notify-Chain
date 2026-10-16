/**
 * Notification Providers - Public API
 *
 * Exports the core types, manager, and implementations.
 */

// Types
export type {
  NotificationProvider,
  NotificationProviderManager,
  ProviderConfig,
  ProviderSendResult,
  ProviderFailureHandler,
  ProviderSuccessHandler,
} from './types';

export { ProviderStatus } from './types';

// Manager
export { ProviderManager, createProviderManager } from './manager';

// Implementations
export { ConsoleProvider } from './consoleProvider';
export {
  WebhookProvider,
  createWebhookProvider,
  type WebhookProviderConfig,
} from './webhookProvider';
export {
  EmailProvider,
  createEmailProvider,
  type EmailProviderConfig,
} from './emailProvider';
