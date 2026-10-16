/**
 * Provider Capability Metadata System (Issue #708)
 *
 * Enables notification providers to declare supported capabilities (rich formatting,
 * embeds, attachments, message updates) and gracefully downgrades unsupported features.
 */

export enum NotificationCapability {
  RICH_FORMATTING = 'rich_formatting', // Markdown, bold, italics
  EMBEDDED_LINKS = 'embedded_links',   // Clickable hyperlink buttons
  ATTACHMENTS = 'attachments',         // File uploads, image media
  MESSAGE_UPDATES = 'message_updates', // Editing dispatched notifications
  THREADING = 'threading',             // Thread/channel reply nesting
  BATCHING = 'batching',               // Multi-event batch payload delivery
}

export interface ProviderCapabilities {
  providerName: string;
  version: string;
  supportedCapabilities: Set<NotificationCapability>;
  maxPayloadBytes: number;
  maxBatchSize: number;
}

export interface NotificationPayload {
  title: string;
  body: string;
  markdownContent?: string;
  attachments?: Array<{ filename: string; url: string }>;
  actions?: Array<{ label: string; url: string }>;
}

export interface FormattedNotification {
  renderedText: string;
  hasDegradedFeatures: boolean;
  omittedFeatures: NotificationCapability[];
}

/**
 * Standard Capability Profiles for Core Providers
 */
export const DISCORD_CAPABILITY_PROFILE: ProviderCapabilities = {
  providerName: 'Discord',
  version: '1.0.0',
  supportedCapabilities: new Set([
    NotificationCapability.RICH_FORMATTING,
    NotificationCapability.EMBEDDED_LINKS,
    NotificationCapability.ATTACHMENTS,
    NotificationCapability.BATCHING,
  ]),
  maxPayloadBytes: 8192,
  maxBatchSize: 10,
};

export const WEBHOOK_CAPABILITY_PROFILE: ProviderCapabilities = {
  providerName: 'GenericWebhook',
  version: '1.0.0',
  supportedCapabilities: new Set([
    NotificationCapability.RICH_FORMATTING,
    NotificationCapability.BATCHING,
  ]),
  maxPayloadBytes: 65536,
  maxBatchSize: 100,
};

export const SMS_CAPABILITY_PROFILE: ProviderCapabilities = {
  providerName: 'SMS',
  version: '1.0.0',
  supportedCapabilities: new Set([]), // Plain text only
  maxPayloadBytes: 160,
  maxBatchSize: 1,
};

/**
 * Adapts and degrades a notification payload according to the destination provider's capabilities.
 */
export function adaptPayloadForProvider(
  payload: NotificationPayload,
  capabilities: ProviderCapabilities
): FormattedNotification {
  const omittedFeatures: NotificationCapability[] = [];
  let renderedText = '';

  // 1. Formatting
  if (capabilities.supportedCapabilities.has(NotificationCapability.RICH_FORMATTING)) {
    renderedText = payload.markdownContent || `**${payload.title}**\n${payload.body}`;
  } else {
    // Strip markdown formatting
    renderedText = `${payload.title}\n${payload.body}`
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    if (payload.markdownContent) {
      omittedFeatures.push(NotificationCapability.RICH_FORMATTING);
    }
  }

  // 2. Action links
  if (payload.actions && payload.actions.length > 0) {
    if (capabilities.supportedCapabilities.has(NotificationCapability.EMBEDDED_LINKS)) {
      const linkList = payload.actions.map((a) => `[${a.label}](${a.url})`).join(' | ');
      renderedText += `\n\n${linkList}`;
    } else {
      // Append raw URLs
      const rawUrls = payload.actions.map((a) => `${a.label}: ${a.url}`).join('\n');
      renderedText += `\n\n${rawUrls}`;
      omittedFeatures.push(NotificationCapability.EMBEDDED_LINKS);
    }
  }

  // 3. Attachments
  if (payload.attachments && payload.attachments.length > 0) {
    if (!capabilities.supportedCapabilities.has(NotificationCapability.ATTACHMENTS)) {
      omittedFeatures.push(NotificationCapability.ATTACHMENTS);
      renderedText += `\n(Attachments omitted: ${payload.attachments.map((a) => a.filename).join(', ')})`;
    }
  }

  return {
    renderedText,
    hasDegradedFeatures: omittedFeatures.length > 0,
    omittedFeatures,
  };
}
