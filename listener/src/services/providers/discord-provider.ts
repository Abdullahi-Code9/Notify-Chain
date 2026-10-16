import {
  ProviderCapability,
  ProviderMetadata,
  NotificationProvider,
  DeliveryPayload,
  DeliveryResult,
  ProviderHealthResult,
} from '../../types/provider-capabilities';
import { DiscordNotificationService, DiscordMessage } from '../discord-notification';
import { DiscordConfig } from '../../types';
import { sendWebhook } from '../webhook-sender';
import { sanitizeCredentials } from '../../utils/credential-sanitizer';
import logger from '../../utils/logger';

const DISCORD_CAPABILITIES = new Set<ProviderCapability>([
  ProviderCapability.RICH_FORMATTING,
  ProviderCapability.ATTACHMENTS,
  ProviderCapability.MESSAGE_UPDATES,
  ProviderCapability.THREADING,
  ProviderCapability.INTERACTIVE_COMPONENTS,
]);

export class DiscordNotificationProvider implements NotificationProvider {
  readonly metadata: ProviderMetadata = {
    id: 'discord',
    name: 'Discord Webhook',
    version: '1.0.0',
    capabilities: DISCORD_CAPABILITIES,
  };

  private readonly service: DiscordNotificationService;
  private readonly defaultWebhookUrl?: string;

  constructor(config: DiscordConfig, service?: DiscordNotificationService) {
    this.service = service ?? new DiscordNotificationService(config);
    this.defaultWebhookUrl = config.webhookUrl;
  }

  hasCapability(capability: ProviderCapability): boolean {
    return this.metadata.capabilities.has(capability);
  }

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const { payload: body, targetRecipient, requestedFeatures, requestId } = payload;

    const degradedCapabilities: ProviderCapability[] = [];
    if (requestedFeatures) {
      for (const feature of requestedFeatures) {
        if (!this.hasCapability(feature)) {
          degradedCapabilities.push(feature);
          logger.warn('Discord provider: requested feature not supported — skipping', {
            requestId,
            feature,
            provider: this.metadata.id,
          });
        }
      }
    }

    try {
      const message = this.buildMessage(body);
      const response = await sendWebhook(targetRecipient, message, { timeoutMs: 5_000 });
      const providerMessageId = response.headers.get('x-message-id') ?? undefined;
      const providerResponse = { statusCode: response.status };

      if (!response.ok) {
        logger.warn('Discord provider: webhook responded with non-OK status', {
          requestId,
          targetRecipient: sanitizeCredentials(targetRecipient),
          status: response.status,
          body: sanitizeCredentials(errorText),
        });
        return {
          success: false,
          degradedCapabilities,
          errorMessage: `HTTP ${response.status}: ${sanitizeCredentials(errorText)}`,
        };
      }

      logger.info('Discord provider: message delivered', {
        requestId,
        targetRecipient: sanitizeCredentials(targetRecipient),
      });
      return { success: true, degradedCapabilities };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeCredentials(errorMessage);
      logger.error('Discord provider: delivery error', {
        requestId,
        targetRecipient: sanitizeCredentials(targetRecipient),
        error: sanitized,
      });
      return { success: false, degradedCapabilities, errorMessage: sanitized };
    }
  }

  /**
   * Independently checks Discord provider reachability.
   * Redacts any webhook token or credential from failure details.
   */
  async checkHealth(targetRecipient?: string): Promise<ProviderHealthResult> {
    const url = targetRecipient || this.defaultWebhookUrl;
    const checkedAt = new Date().toISOString();

    if (!url) {
      return {
        providerId: this.metadata.id,
        providerName: this.metadata.name,
        status: 'not_configured',
        detail: 'No Discord webhook URL configured',
        checkedAt,
      };
    }

    const start = Date.now();
    try {
      // Discord Webhook GET endpoint returns metadata (id, name, guild_id) without posting a message
      const response = await fetch(url, { method: 'GET' });
      const latencyMs = Date.now() - start;

      if (response.ok) {
        return {
          providerId: this.metadata.id,
          providerName: this.metadata.name,
          status: 'ok',
          latencyMs,
          checkedAt,
        };
      }

      return {
        providerId: this.metadata.id,
        providerName: this.metadata.name,
        status: 'error',
        latencyMs,
        detail: `HTTP ${response.status}`,
        checkedAt,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const rawDetail = err instanceof Error ? err.message : String(err);
      return {
        providerId: this.metadata.id,
        providerName: this.metadata.name,
        status: 'error',
        latencyMs,
        detail: sanitizeCredentials(rawDetail),
        checkedAt,
      };
    }
  }

  private buildMessage(body: Record<string, unknown>): DiscordMessage {
    if (body.message && typeof body.message === 'object') {
      return body.message as DiscordMessage;
    }

    if (Array.isArray(body.embeds)) {
      return { embeds: body.embeds as DiscordMessage['embeds'] };
    }

    const text =
      typeof body.content === 'string'
        ? body.content
        : typeof body.text === 'string'
        ? body.text
        : JSON.stringify(body).slice(0, 2_000);

    return { content: text };
  }

  getMetrics() {
    return this.service.getMetrics();
  }
}