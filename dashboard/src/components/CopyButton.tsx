import { useCopyId } from '../hooks/useCopyId';

interface CopyButtonProps {
  value: string;
  /** Shown in aria-label, e.g. "event ID" → "Copy event ID" */
  label: string;
  /** Visual size variant */
  size?: 'sm' | 'xs';
}

export function CopyButton({ value, label, size = 'sm' }: CopyButtonProps) {
  const { copy, copied } = useCopyId();

  return (
    <button
      type="button"
      className={`copy-btn copy-btn--${size}${copied ? ' copy-btn--copied' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy(value);
      }}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied!' : `Copy ${label}`}
    >
      {copied ? (
        <span className="copy-btn__icon" aria-hidden="true">
          ✓
        </span>
      ) : (
        <span className="copy-btn__icon" aria-hidden="true">
          ⎘
        </span>
      )}
      <span className="copy-btn__label">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
