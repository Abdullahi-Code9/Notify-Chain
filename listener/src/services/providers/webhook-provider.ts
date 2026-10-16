import {
  ProviderCapability,
  ProviderMetadata,
  NotificationProvider,
  DeliveryPayload,
  DeliveryResult,
  ProviderHealthResult,
} from '../../types/provider-capabilities';
import { sendWebhook, WebhookSendOptions } from '../webhook-sender';
import { sanitizeCredentials } from '../../utils/credential-sanitizer';
import logger from '../../utils/logger';

export interface WebhookProviderConfig {
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  /** Optional health probe URL for diagnostic verification */
  healthCheckUrl?: string;
}

const WEBHOOK_CAPABILITIES = new Set<ProviderCapability>([
  ProviderCapability.ATTACHMENTS,
]);

export class WebhookNotificationProvider implements NotificationProvider {
  readonly metadata: ProviderMetadata = {
    id: 'webhook',
    name: 'HTTP Webhook',
    version: '1.0.0',
    capabilities: WEBHOOK_CAPABILITIES,
  };

  private readonly config: Required<Omit<WebhookProviderConfig, 'healthCheckUrl'>> & {
    healthCheckUrl?: string;
  };

  constructor(config: WebhookProviderConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 5_000,
      defaultHeaders: config.defaultHeaders ?? {},
      healthCheckUrl: config.healthCheckUrl,
    };
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
          logger.warn('Webhook provider: requested feature not supported — skipping', {
            requestId,
            feature,
            provider: this.metadata.id,
          });
        }
      }
    }

    const opts: WebhookSendOptions = {
      timeoutMs: this.config.timeoutMs,
      headers: { ...this.config.defaultHeaders },
    };

    try {
      const response = await sendWebhook(targetRecipient, body, opts);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.warn('Webhook provider: endpoint responded with non-OK status', {
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

      logger.info('Webhook provider: payload delivered', {
        requestId,
        targetRecipient: sanitizeCredentials(targetRecipient),
      });
      return { success: true, degradedCapabilities };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeCredentials(errorMessage);
      logger.error('Webhook provider: delivery error', {
        requestId,
        targetRecipient: sanitizeCredentials(targetRecipient),
        error: sanitized,
      });
      return { success: false, degradedCapabilities, errorMessage: sanitized };
    }
  }

  /**
   * Independently checks Webhook provider reachability.
   * Redacts any credential or token from failure reports.
   */
  async checkHealth(targetRecipient?: string): Promise<ProviderHealthResult> {
    const url = targetRecipient || this.config.healthCheckUrl;
    const checkedAt = new Date().toISOString();

    if (!url) {
      return {
        providerId: this.metadata.id,
        providerName: this.metadata.name,
        status: 'not_configured',
        detail: 'No destination or health probe URL configured',
        checkedAt,
      };
    }

    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: this.config.defaultHeaders,
      });
      const latencyMs = Date.now() - start;

      if (response.ok || response.status === 405) {
        // 2xx or 405 (Method Not Allowed for HEAD) proves endpoint is alive
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
}