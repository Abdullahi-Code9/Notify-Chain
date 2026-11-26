import type {
  DestinationFieldDefinition,
  DestinationProvider,
  DestinationValidationErrors,
  NotificationDestination,
  SecretFieldState,
} from '../types/destination';

/** Supported providers and their configuration fields (issue #1107). */
export const PROVIDER_FIELDS: Record<DestinationProvider, DestinationFieldDefinition[]> = {
  webhook: [
    {
      key: 'url',
      label: 'Endpoint URL',
      type: 'url',
      secret: false,
      required: true,
      placeholder: 'https://example.com/hooks/notify-chain',
    },
    {
      key: 'signingSecret',
      label: 'Signing secret',
      type: 'text',
      secret: true,
      required: true,
      help: 'Used to sign payloads (HMAC-SHA256). Stored server-side only.',
    },
  ],
  discord: [
    {
      key: 'webhookUrl',
      label: 'Discord webhook URL',
      type: 'url',
      secret: true,
      required: true,
      help: 'Discord webhook URLs grant posting access and are treated as secrets.',
    },
  ],
  email: [
    {
      key: 'fromAddress',
      label: 'From address',
      type: 'email',
      secret: false,
      required: true,
      placeholder: 'alerts@example.com',
    },
    {
      key: 'apiKey',
      label: 'Email provider API key',
      type: 'text',
      secret: true,
      required: true,
    },
  ],
  telegram: [
    {
      key: 'chatId',
      label: 'Chat ID',
      type: 'text',
      secret: false,
      required: true,
      placeholder: '-1001234567890 or @channel',
    },
    {
      key: 'botToken',
      label: 'Bot token',
      type: 'text',
      secret: true,
      required: true,
    },
  ],
};

export const PROVIDER_LABELS: Record<DestinationProvider, string> = {
  webhook: 'Webhook',
  discord: 'Discord',
  email: 'Email',
  telegram: 'Telegram',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_CHAT_PATTERN = /^(-?\d{5,}|@[A-Za-z0-9_]{5,})$/;

/** Fixed-width mask so the length of a secret is never revealed. */
export function maskSecret(state: SecretFieldState | undefined): string {
  if (!state?.isSet) return 'Not set';
  return state.last4 ? `••••••••${state.last4}` : '••••••••';
}

function validateUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'Must be an HTTPS URL.';
    if (url.username || url.password) return 'Credentials must not be embedded in the URL.';
    return null;
  } catch {
    return 'Must be a valid URL.';
  }
}

/**
 * Validates a pending edit before it is submitted.
 *
 * A required secret is satisfied either by a newly entered value or by an
 * existing secret already stored server-side. Validation only applies while
 * the destination is enabled, so a destination can be disabled while
 * incomplete.
 */
export function validateDestination(
  provider: DestinationProvider,
  enabled: boolean,
  settings: Record<string, string>,
  newSecrets: Record<string, string>,
  existingSecrets: Record<string, SecretFieldState>,
): DestinationValidationErrors {
  const errors: DestinationValidationErrors = {};
  if (!enabled) return errors;

  for (const field of PROVIDER_FIELDS[provider]) {
    const raw = field.secret ? newSecrets[field.key] : settings[field.key];
    const value = (raw ?? '').trim();
    const hasStoredSecret = field.secret && existingSecrets[field.key]?.isSet === true;

    if (!value) {
      if (field.required && !hasStoredSecret) {
        errors[field.key] = `${field.label} is required.`;
      }
      continue;
    }

    if (field.type === 'url') {
      const urlError = validateUrl(value);
      if (urlError) errors[field.key] = urlError;
    } else if (field.type === 'email' && !EMAIL_PATTERN.test(value)) {
      errors[field.key] = 'Must be a valid email address.';
    } else if (field.secret && value.length < 8) {
      errors[field.key] = `${field.label} looks too short.`;
    }

    if (provider === 'telegram' && field.key === 'chatId' && !TELEGRAM_CHAT_PATTERN.test(value)) {
      errors[field.key] = 'Must be a numeric chat ID or an @channel name.';
    }
  }

  return errors;
}

/** Whether a destination has enough configuration to send a test notification. */
export function canSendTest(destination: NotificationDestination): boolean {
  return destination.enabled && destination.status !== 'not_configured';
}
