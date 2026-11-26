import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  DestinationConnectionStatus,
  DestinationValidationErrors,
  NotificationDestination,
  TestNotificationResult,
} from '../types/destination';
import {
  DestinationApiError,
  defaultDestinationsClient,
  type DestinationsClient,
} from '../services/destinationsApi';
import {
  PROVIDER_FIELDS,
  PROVIDER_LABELS,
  canSendTest,
  maskSecret,
  validateDestination,
} from '../utils/destinationValidation';
import { formatTimestamp } from '../utils/formatTime';
import { useActiveTimeZone } from '../store/timezoneStore';

/**
 * Unified notification destination configuration page (issue #1107).
 *
 * Lists every supported provider with its connection status, lets operators
 * update settings (secrets are write-only and always masked), surfaces
 * validation/configuration errors inline, and sends safe test notifications.
 */

const STATUS_LABELS: Record<DestinationConnectionStatus, string> = {
  connected: 'Connected',
  not_configured: 'Not configured',
  error: 'Configuration error',
  disabled: 'Disabled',
};

const STATUS_BADGE: Record<DestinationConnectionStatus, string> = {
  connected: 'destination-status--connected',
  not_configured: 'destination-status--not-configured',
  error: 'destination-status--error',
  disabled: 'destination-status--disabled',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; destinations: NotificationDestination[] };

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

interface DestinationCardProps {
  destination: NotificationDestination;
  client: DestinationsClient;
  onUpdated: (destination: NotificationDestination) => void;
}

function DestinationCard({ destination, client, onUpdated }: DestinationCardProps) {
  const formId = useId();
  const timeZone = useActiveTimeZone();
  const fields = PROVIDER_FIELDS[destination.provider];

  const [enabled, setEnabled] = useState(destination.enabled);
  const [settings, setSettings] = useState<Record<string, string>>(destination.settings);
  const [newSecrets, setNewSecrets] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<DestinationValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestNotificationResult | null>(null);

  // Re-sync local form state when the server copy changes.
  useEffect(() => {
    setEnabled(destination.enabled);
    setSettings(destination.settings);
  }, [destination]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaveMessage(null);

    const validation = validateDestination(
      destination.provider,
      enabled,
      settings,
      newSecrets,
      destination.secrets,
    );
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;

    const changedSecrets = Object.fromEntries(
      Object.entries(newSecrets).filter(([, value]) => value.trim() !== ''),
    );

    setSaving(true);
    try {
      const updated = await client.update(destination.id, {
        enabled,
        settings,
        ...(Object.keys(changedSecrets).length > 0 ? { secrets: changedSecrets } : {}),
      });
      // Never keep plaintext secrets in component state after submission.
      setNewSecrets({});
      setRevealed({});
      setSaveMessage('Settings saved.');
      onUpdated(updated);
    } catch (err) {
      if (err instanceof DestinationApiError && Object.keys(err.fieldErrors).length > 0) {
        setErrors(err.fieldErrors);
      }
      setErrors((prev) => ({ ...prev, _form: errorMessage(err, 'Failed to save settings.') }));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await client.sendTest(destination.id));
    } catch (err) {
      setTestResult({ success: false, message: errorMessage(err, 'Test notification failed.') });
    } finally {
      setTesting(false);
    }
  }, [client, destination.id]);

  const testDisabled = testing || !canSendTest(destination);
  const headingId = `${formId}-heading`;

  return (
    <section className="destination-card" aria-labelledby={headingId} data-provider={destination.provider}>
      <header className="destination-card__header">
        <div>
          <h2 id={headingId} className="destination-card__title">
            {destination.displayName || PROVIDER_LABELS[destination.provider]}
          </h2>
          <p className="destination-card__provider">{PROVIDER_LABELS[destination.provider]}</p>
          {destination.ownerId && (
            <p className="destination-card__owner" data-testid={`owner-${destination.id}`}>
              Owner: {destination.ownerId}
            </p>
          )}
        </div>
        <span
          className={`destination-status ${STATUS_BADGE[destination.status]}`}
          data-testid={`status-${destination.id}`}
        >
          {STATUS_LABELS[destination.status]}
        </span>
      </header>

      {destination.lastError && (
        <p className="destination-card__error" role="alert">
          {destination.lastError}
        </p>
      )}

      <form className="destination-card__form" onSubmit={handleSubmit} noValidate>
        <label className="destination-card__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>

        {fields.map((field) => {
          const inputId = `${formId}-${field.key}`;
          const errorId = `${inputId}-error`;
          const helpId = `${inputId}-help`;
          const error = errors[field.key];
          const describedBy = [error ? errorId : null, field.help || field.secret ? helpId : null]
            .filter(Boolean)
            .join(' ') || undefined;

          if (field.secret) {
            const current = destination.secrets[field.key];
            return (
              <div key={field.key} className="destination-card__field">
                <label htmlFor={inputId}>{field.label}</label>
                <div className="destination-card__secret-row">
                  <input
                    id={inputId}
                    type={revealed[field.key] ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    value={newSecrets[field.key] ?? ''}
                    placeholder={current?.isSet ? 'Leave blank to keep current value' : 'Enter value'}
                    onChange={(e) =>
                      setNewSecrets((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy}
                  />
                  <button
                    type="button"
                    className="destination-card__reveal"
                    onClick={() =>
                      setRevealed((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                    }
                    aria-label={`${revealed[field.key] ? 'Hide' : 'Show'} new ${field.label}`}
                    disabled={!newSecrets[field.key]}
                  >
                    {revealed[field.key] ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p id={helpId} className="destination-card__help">
                  Current: <span data-testid={`secret-${destination.id}-${field.key}`}>{maskSecret(current)}</span>
                  {field.help ? ` — ${field.help}` : ''}
                </p>
                {error && (
                  <p id={errorId} className="destination-card__field-error">
                    {error}
                  </p>
                )}
              </div>
            );
          }

          return (
            <div key={field.key} className="destination-card__field">
              <label htmlFor={inputId}>{field.label}</label>
              <input
                id={inputId}
                type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
                value={settings[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => setSettings((prev) => ({ ...prev, [field.key]: e.target.value }))}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
              />
              {field.help && (
                <p id={helpId} className="destination-card__help">
                  {field.help}
                </p>
              )}
              {error && (
                <p id={errorId} className="destination-card__field-error">
                  {error}
                </p>
              )}
            </div>
          );
        })}

        {errors._form && (
          <p className="destination-card__error" role="alert">
            {errors._form}
          </p>
        )}
        {saveMessage && (
          <p className="destination-card__success" role="status">
            {saveMessage}
          </p>
        )}

        <div className="destination-card__actions">
          <button type="submit" className="destination-card__save" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button
            type="button"
            className="destination-card__test"
            onClick={() => void handleTest()}
            disabled={testDisabled}
            title={
              canSendTest(destination)
                ? 'Send a test notification marked as a test; no real event data is used.'
                : 'Enable and save a complete configuration before sending a test.'
            }
          >
            {testing ? 'Sending test…' : 'Send test notification'}
          </button>
        </div>
      </form>

      <div aria-live="polite" className="destination-card__test-result">
        {testResult && (
          <p
            className={
              testResult.success ? 'destination-card__success' : 'destination-card__error'
            }
            role={testResult.success ? 'status' : 'alert'}
          >
            {testResult.success ? 'Test notification delivered' : 'Test notification failed'}
            {`: ${testResult.message}`}
            {typeof testResult.latencyMs === 'number' ? ` (${testResult.latencyMs} ms)` : ''}
          </p>
        )}
      </div>

      {destination.lastTestedAt ? (
        <p className="destination-card__meta">
          Last tested: {formatTimestamp(destination.lastTestedAt, timeZone)}
        </p>
      ) : null}
    </section>
  );
}

export function NotificationDestinationsPage({
  client = defaultDestinationsClient,
}: {
  client?: DestinationsClient;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', destinations: await client.list() });
    } catch (err) {
      setState({ status: 'error', message: errorMessage(err, 'Failed to load destinations.') });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpdated = useCallback((updated: NotificationDestination) => {
    setState((prev) =>
      prev.status === 'ready'
        ? {
            status: 'ready',
            destinations: prev.destinations.map((d) => (d.id === updated.id ? updated : d)),
          }
        : prev,
    );
  }, []);

  return (
    <div className="destinations-page">
      <header className="destinations-page__header">
        <h1>Notification Destinations</h1>
        <p>
          Configure every delivery provider in one place. Secrets are write-only and always
          masked.
        </p>
      </header>

      {state.status === 'loading' && (
        <p role="status" aria-busy="true">
          Loading destinations…
        </p>
      )}

      {state.status === 'error' && (
        <div className="destinations-page__error" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {state.status === 'ready' && state.destinations.length === 0 && (
        <p>No notification destinations are available.</p>
      )}

      {state.status === 'ready' && state.destinations.length > 0 && (
        <div className="destinations-page__grid">
          {state.destinations.map((destination) => (
            <DestinationCard
              key={destination.id}
              destination={destination}
              client={client}
              onUpdated={handleUpdated}
            />
          ))}
        </div>
      )}
    </div>
  );
}
