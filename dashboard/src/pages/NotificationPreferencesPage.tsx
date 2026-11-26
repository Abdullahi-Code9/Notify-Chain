import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { FormField, FormInput } from '../components/FormField';

type ChannelKey = 'inApp' | 'email' | 'discord' | 'telegram';
type CategoryKey = 'security' | 'governance' | 'system' | 'custom';
type PreferencesRow = Record<ChannelKey, boolean>;
type PreferencesMatrix = Record<CategoryKey, PreferencesRow>;

type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

type QuietHoursConfig = {
  enabled: boolean;
  start: string;
  end: string;
};

type DeliveryWindowConfig = {
  enabled: boolean;
  days: WeekdayKey[];
  start: string;
  end: string;
  timezone: string;
};

type DeliverySchedule = {
  quietHours: QuietHoursConfig;
  deliveryWindow: DeliveryWindowConfig;
};

const weekdayDefinitions: { key: WeekdayKey; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const timezoneOptions = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

const defaultDeliverySchedule: DeliverySchedule = {
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  deliveryWindow: {
    enabled: false,
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '09:00',
    end: '18:00',
    timezone: 'UTC',
  },
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTime(value: string) {
  return TIME_PATTERN.test(value.trim());
}

const channelDefinitions = [
  { key: 'inApp' as const, label: 'In-App' },
  { key: 'email' as const, label: 'Email' },
  { key: 'discord' as const, label: 'Discord' },
  { key: 'telegram' as const, label: 'Telegram' },
];

const categoryDefinitions = [
  {
    key: 'security' as const,
    label: 'Security Alerts',
    description: 'Critical account and access events.',
  },
  {
    key: 'governance' as const,
    label: 'Protocol Governance',
    description: 'Voting, proposals and governance lifecycle updates.',
  },
  {
    key: 'system' as const,
    label: 'System Updates',
    description: 'Platform health, maintenance windows, and service notices.',
  },
  {
    key: 'custom' as const,
    label: 'Custom Triggers',
    description: 'User-defined automations and webhook-style notifications.',
  },
];

const defaultPreferences: PreferencesMatrix = {
  security: { inApp: true, email: true, discord: false, telegram: false },
  governance: { inApp: true, email: false, discord: true, telegram: false },
  system: { inApp: true, email: false, discord: false, telegram: true },
  custom: { inApp: false, email: false, discord: true, telegram: true },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_PATTERN = /^@[A-Za-z0-9_]{3,}$/;

function validateEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim());
}

function validateTelegram(value: string) {
  return TELEGRAM_PATTERN.test(value.trim());
}

export function NotificationPreferencesPage() {
  const [preferences, setPreferences] = useState<PreferencesMatrix>(defaultPreferences);
  const [contactEmail, setContactEmail] = useState('recipient@example.com');
  const [telegramHandle, setTelegramHandle] = useState('@notifychain');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [deliverySchedule, setDeliverySchedule] =
    useState<DeliverySchedule>(defaultDeliverySchedule);

  const errorCategories = useMemo(
    () =>
      categoryDefinitions
        .filter((category) => !Object.values(preferences[category.key]).some(Boolean))
        .map((category) => category.label),
    [preferences],
  );

  const emailSelected = useMemo(
    () => Object.values(preferences).some((row) => row.email),
    [preferences],
  );

  const telegramSelected = useMemo(
    () => Object.values(preferences).some((row) => row.telegram),
    [preferences],
  );

  const emailInvalid = useMemo(
    () => emailSelected && !validateEmail(contactEmail),
    [contactEmail, emailSelected],
  );

  const telegramInvalid = useMemo(
    () => telegramSelected && !validateTelegram(telegramHandle),
    [telegramHandle, telegramSelected],
  );

  const quietHoursInvalid = useMemo(
    () =>
      deliverySchedule.quietHours.enabled &&
      (!isValidTime(deliverySchedule.quietHours.start) ||
        !isValidTime(deliverySchedule.quietHours.end)),
    [deliverySchedule.quietHours],
  );

  const deliveryWindowInvalid = useMemo(() => {
    const window = deliverySchedule.deliveryWindow;
    if (!window.enabled) {
      return false;
    }
    return (
      window.days.length === 0 ||
      !isValidTime(window.start) ||
      !isValidTime(window.end) ||
      window.timezone.trim().length === 0
    );
  }, [deliverySchedule.deliveryWindow]);

  const canSave = useMemo(
    () =>
      !isLoading &&
      !loadError &&
      !emailInvalid &&
      !telegramInvalid &&
      !quietHoursInvalid &&
      !deliveryWindowInvalid &&
      errorCategories.length === 0,
    [
      deliveryWindowInvalid,
      emailInvalid,
      errorCategories.length,
      isLoading,
      loadError,
      quietHoursInvalid,
      telegramInvalid,
    ],
  );

  const summaryText = useMemo(() => {
    const channelCounts = channelDefinitions.map((channel) => {
      const count = categoryDefinitions.reduce(
        (total, category) => total + (preferences[category.key][channel.key] ? 1 : 0),
        0,
      );
      return `${channel.label}: ${count}`;
    });
    return `Active routing: ${channelCounts.join(' • ')}`;
  }, [preferences]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setSaveState('idle');

    const timer = window.setTimeout(() => {
      if (cancelled) {
        return;
      }

      if (simulateFailure) {
        setLoadError('Unable to retrieve notification settings. Toggle the simulation or retry.');
        setIsLoading(false);
        return;
      }

      setPreferences(defaultPreferences);
      setDeliverySchedule(defaultDeliverySchedule);
      setLoadError(null);
      setIsLoading(false);
    }, 780);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [simulateFailure]);

  const handleTogglePreference = useCallback((categoryKey: CategoryKey, channelKey: ChannelKey) => {
    setPreferences((current) => ({
      ...current,
      [categoryKey]: {
        ...current[categoryKey],
        [channelKey]: !current[categoryKey][channelKey],
      },
    }));
    setSaveState('idle');
  }, []);

  const handleToggleQuietHours = useCallback((enabled: boolean) => {
    setDeliverySchedule((current) => ({
      ...current,
      quietHours: { ...current.quietHours, enabled },
    }));
    setSaveState('idle');
  }, []);

  const handleQuietHoursTimeChange = useCallback(
    (field: 'start' | 'end', value: string) => {
      setDeliverySchedule((current) => ({
        ...current,
        quietHours: { ...current.quietHours, [field]: value },
      }));
      setSaveState('idle');
    },
    [],
  );

  const handleToggleDeliveryWindow = useCallback((enabled: boolean) => {
    setDeliverySchedule((current) => ({
      ...current,
      deliveryWindow: { ...current.deliveryWindow, enabled },
    }));
    setSaveState('idle');
  }, []);

  const handleToggleDeliveryDay = useCallback((day: WeekdayKey) => {
    setDeliverySchedule((current) => {
      const days = current.deliveryWindow.days.includes(day)
        ? current.deliveryWindow.days.filter((entry) => entry !== day)
        : [...current.deliveryWindow.days, day];
      return {
        ...current,
        deliveryWindow: { ...current.deliveryWindow, days },
      };
    });
    setSaveState('idle');
  }, []);

  const handleDeliveryWindowChange = useCallback(
    (field: 'start' | 'end' | 'timezone', value: string) => {
      setDeliverySchedule((current) => ({
        ...current,
        deliveryWindow: { ...current.deliveryWindow, [field]: value },
      }));
      setSaveState('idle');
    },
    [],
  );

  const handleSave = useCallback(() => {
    if (!canSave) {
      return;
    }

    setSaveState('saving');
    window.setTimeout(() => {
      setSaveState('saved');
    }, 600);
  }, [canSave]);

  const handleRetry = useCallback(() => {
    setSimulateFailure(false);
    setIsLoading(true);
    setLoadError(null);
  }, []);

  return (
    <main className="notification-preferences-page">
      <header className="notification-preferences__header">
        <div>
          <p className="notification-preferences__eyebrow">Notification Preferences</p>
          <h1>Recipient preference control panel</h1>
          <p className="notification-preferences__lead">
            Toggle notification channels for each recipient category and validate contact fields
            before saving.
          </p>
        </div>
        <div className="notification-preferences__header-actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setSimulateFailure((current) => !current)}
          >
            {simulateFailure ? 'Disable error simulation' : 'Simulate load error'}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={handleRetry}
            disabled={!loadError}
          >
            Reload preferences
          </button>
        </div>
      </header>

      <div className="notification-preferences__status-row">
        <p className="notification-preferences__status-text">{summaryText}</p>
        {isLoading && <span className="notification-preferences__pill">Loading…</span>}
        {loadError && (
          <span className="notification-preferences__pill notification-preferences__pill--error">
            Error
          </span>
        )}
        {saveState === 'saved' && (
          <span className="notification-preferences__pill notification-preferences__pill--success">
            Saved
          </span>
        )}
      </div>

      {isLoading ? (
        <section className="notification-preferences__skeleton" aria-busy="true">
          <div className="skeleton-block skeleton-block--header" />
          <div className="skeleton-block skeleton-block--row" />
          <div className="skeleton-block skeleton-block--row" />
          <div className="skeleton-block skeleton-block--row" />
        </section>
      ) : loadError ? (
        <section className="notification-preferences__error-panel" role="alert">
          <strong>Unable to load preferences.</strong>
          <p>Use the button above to retry or disable the simulated error boundary.</p>
        </section>
      ) : (
        <div className="notification-preferences__workspace">
          <section
            className="notification-preferences__matrix-panel"
            aria-labelledby="notification-matrix-title"
          >
            <div className="notification-preferences__panel-header">
              <div>
                <h2 id="notification-matrix-title">Delivery matrix</h2>
                <p>
                  Map channels to notification categories with fast toggles and immediate validation
                  feedback.
                </p>
              </div>
              <p className="notification-preferences__matrix-note">
                Categories must route through at least one channel. Email and Telegram require valid
                contact details.
              </p>
            </div>

            <div
              className="notification-preferences__matrix"
              role="table"
              aria-label="Notification preference matrix"
            >
              <div className="matrix-cell matrix-cell--corner">Categories / Channels</div>
              {channelDefinitions.map((channel) => (
                <div key={channel.key} className="matrix-cell matrix-cell--header">
                  {channel.label}
                </div>
              ))}

              {categoryDefinitions.map((category) => (
                <Fragment key={category.key}>
                  <div className="matrix-cell matrix-cell--category">
                    <div>{category.label}</div>
                    <p>{category.description}</p>
                  </div>
                  {channelDefinitions.map((channel) => {
                    const fieldId = `pref-${category.key}-${channel.key}`;
                    return (
                      <label
                        key={fieldId}
                        className="matrix-cell matrix-cell--toggle"
                        htmlFor={fieldId}
                      >
                        <input
                          id={fieldId}
                          type="checkbox"
                          checked={preferences[category.key][channel.key]}
                          onChange={() => handleTogglePreference(category.key, channel.key)}
                        />
                        <span className="matrix-toggle" aria-hidden="true" />
                      </label>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </section>

          <aside className="notification-preferences__control-panel">
            <div className="notification-preferences__panel-block">
              <h2>Channel details</h2>
              <p>Provide delivery details for email and Telegram routing.</p>
            </div>

            <FormField
              id="contact-email"
              label="Email address"
              error={
                emailInvalid
                  ? 'Email address: enter a valid email when Email notifications are enabled.'
                  : null
              }
            >
              <FormInput
                fieldId="contact-email"
                type="email"
                value={contactEmail}
                onChange={(event) => {
                  setContactEmail(event.target.value);
                  setSaveState('idle');
                }}
                placeholder="recipient@example.com"
                error={
                  emailInvalid
                    ? 'Email address: enter a valid email when Email notifications are enabled.'
                    : null
                }
              />
            </FormField>

            <FormField
              id="telegram-handle"
              label="Telegram handle"
              error={
                telegramInvalid
                  ? 'Telegram handle: must start with @ and contain at least 3 characters.'
                  : null
              }
            >
              <FormInput
                fieldId="telegram-handle"
                type="text"
                value={telegramHandle}
                onChange={(event) => {
                  setTelegramHandle(event.target.value);
                  setSaveState('idle');
                }}
                placeholder="@yourhandle"
                error={
                  telegramInvalid
                    ? 'Telegram handle: must start with @ and contain at least 3 characters.'
                    : null
                }
              />
            </FormField>

            <div className="notification-preferences__panel-block">
              <h2>Quiet hours</h2>
              <p>
                Pause notification delivery during a recurring time range. Events received during
                quiet hours are preserved and delivered once the window closes.
              </p>
            </div>

            <label className="notification-preferences__switch" htmlFor="quiet-hours-enabled">
              <input
                id="quiet-hours-enabled"
                type="checkbox"
                checked={deliverySchedule.quietHours.enabled}
                onChange={(event) => handleToggleQuietHours(event.target.checked)}
              />
              <span>Enable quiet hours</span>
            </label>

            <FormField
              id="quiet-hours-start"
              label="Quiet hours start"
              error={
                quietHoursInvalid
                  ? 'Quiet hours: enter valid times in 24-hour HH:MM format.'
                  : null
              }
            >
              <FormInput
                fieldId="quiet-hours-start"
                type="time"
                value={deliverySchedule.quietHours.start}
                onChange={(event) => handleQuietHoursTimeChange('start', event.target.value)}
                disabled={!deliverySchedule.quietHours.enabled}
                error={
                  quietHoursInvalid
                    ? 'Quiet hours: enter valid times in 24-hour HH:MM format.'
                    : null
                }
              />
            </FormField>

            <FormField
              id="quiet-hours-end"
              label="Quiet hours end"
              error={
                quietHoursInvalid
                  ? 'Quiet hours: enter valid times in 24-hour HH:MM format.'
                  : null
              }
            >
              <FormInput
                fieldId="quiet-hours-end"
                type="time"
                value={deliverySchedule.quietHours.end}
                onChange={(event) => handleQuietHoursTimeChange('end', event.target.value)}
                disabled={!deliverySchedule.quietHours.enabled}
                error={
                  quietHoursInvalid
                    ? 'Quiet hours: enter valid times in 24-hour HH:MM format.'
                    : null
                }
              />
            </FormField>

            <div className="notification-preferences__panel-block">
              <h2>Delivery window</h2>
              <p>
                Restrict notifications to specific days and hours in your timezone. Notifications
                resume automatically when the delivery window opens.
              </p>
            </div>

            <label className="notification-preferences__switch" htmlFor="delivery-window-enabled">
              <input
                id="delivery-window-enabled"
                type="checkbox"
                checked={deliverySchedule.deliveryWindow.enabled}
                onChange={(event) => handleToggleDeliveryWindow(event.target.checked)}
              />
              <span>Enable delivery window</span>
            </label>

            <fieldset
              className="notification-preferences__weekdays"
              disabled={!deliverySchedule.deliveryWindow.enabled}
            >
              <legend>Delivery days</legend>
              {weekdayDefinitions.map((day) => {
                const dayId = `delivery-day-${day.key}`;
                return (
                  <label key={day.key} htmlFor={dayId} className="notification-preferences__weekday">
                    <input
                      id={dayId}
                      type="checkbox"
                      checked={deliverySchedule.deliveryWindow.days.includes(day.key)}
                      onChange={() => handleToggleDeliveryDay(day.key)}
                    />
                    <span>{day.label}</span>
                  </label>
                );
              })}
            </fieldset>

            <FormField
              id="delivery-window-start"
              label="Delivery window start"
              error={
                deliveryWindowInvalid
                  ? 'Delivery window: select at least one day and enter valid times.'
                  : null
              }
            >
              <FormInput
                fieldId="delivery-window-start"
                type="time"
                value={deliverySchedule.deliveryWindow.start}
                onChange={(event) => handleDeliveryWindowChange('start', event.target.value)}
                disabled={!deliverySchedule.deliveryWindow.enabled}
                error={
                  deliveryWindowInvalid
                    ? 'Delivery window: select at least one day and enter valid times.'
                    : null
                }
              />
            </FormField>

            <FormField
              id="delivery-window-end"
              label="Delivery window end"
              error={
                deliveryWindowInvalid
                  ? 'Delivery window: select at least one day and enter valid times.'
                  : null
              }
            >
              <FormInput
                fieldId="delivery-window-end"
                type="time"
                value={deliverySchedule.deliveryWindow.end}
                onChange={(event) => handleDeliveryWindowChange('end', event.target.value)}
                disabled={!deliverySchedule.deliveryWindow.enabled}
                error={
                  deliveryWindowInvalid
                    ? 'Delivery window: select at least one day and enter valid times.'
                    : null
                }
              />
            </FormField>

            <FormField
              id="delivery-window-timezone"
              label="Timezone"
              error={
                deliveryWindowInvalid
                  ? 'Delivery window: select a timezone for the delivery window.'
                  : null
              }
            >
              <select
                id="delivery-window-timezone"
                className="form-input"
                value={deliverySchedule.deliveryWindow.timezone}
                onChange={(event) => handleDeliveryWindowChange('timezone', event.target.value)}
                disabled={!deliverySchedule.deliveryWindow.enabled}
              >
                {timezoneOptions.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </FormField>

            {errorCategories.length > 0 && (
              <div className="notification-preferences__validation-panel" role="alert">
                <strong>Validation required</strong>
                <p>At least one channel must be active for each category.</p>
                <ul>
                  {errorCategories.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="notification-preferences__actions-panel">
              <button
                type="button"
                className="button button--primary button--full"
                onClick={handleSave}
                disabled={!canSave || saveState === 'saving'}
              >
                {saveState === 'saving' ? 'Saving preferences…' : 'Save preferences'}
              </button>
              <p className="notification-preferences__save-note">
                Changes are stored locally for the current session and can be reloaded using the
                controls above.
              </p>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
