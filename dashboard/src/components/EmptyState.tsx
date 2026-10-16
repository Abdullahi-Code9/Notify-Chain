import type { ReactNode } from 'react';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  /** Short heading. Omit for compact placements that only need a message. */
  title?: string;

  /** Primary message (preferred). */
  message?: string;

  /** Legacy alias for message. */
  description?: string;

  /** Emoji string or custom icon node. */
  icon?: string | ReactNode;

  action?: EmptyStateAction;
  size?: 'default' | 'compact' | 'inline';
  className?: string;
  role?: string;
  children?: ReactNode;
}

function DefaultEmptyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 13.5 5.5 5h13L21 13.5" />
      <path d="M3 13.5V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5.5" />
      <path d="M3 13.5h5a1 1 0 0 1 1 1 3 3 0 0 0 6 0 1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function renderIcon(icon: string | ReactNode | undefined) {
  if (icon == null) {
    return <DefaultEmptyIcon />;
  }

  if (typeof icon === 'string') {
    return (
      <span className="empty-state__icon-emoji" aria-hidden="true">
        {icon}
      </span>
    );
  }

  return icon;
}

export function EmptyState({
  title,
  message,
  description,
  icon,
  action,
  size = 'default',
  className,
  role = 'status',
  children,
}: EmptyStateProps) {
  const body = message ?? description ?? '';

  const classes = [
    'empty-state',
    `empty-state--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role={role} aria-live="polite">
      <div className="empty-state__icon">
        {renderIcon(icon)}
      </div>

      {title && (
        <h2 className="empty-state__title">
          {title}
        </h2>
      )}

      {body && (
        <p className="empty-state__message empty-state__description">
          {body}
        </p>
      )}

      {children}

      {action && (
        <button
          type="button"
          className="empty-state__action button button--secondary"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}