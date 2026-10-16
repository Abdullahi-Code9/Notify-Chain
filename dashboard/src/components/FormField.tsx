import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export interface FormFieldErrorProps {
  id: string;
  children: ReactNode;
}

/** Accessible inline validation message associated with a control (#678). */
export function FormFieldError({ id, children }: FormFieldErrorProps) {
  return (
    <p id={id} className="form-field__error" role="alert">
      <span className="form-field__error-icon" aria-hidden="true">
        !
      </span>
      <span className="form-field__error-text">{children}</span>
    </p>
  );
}

export interface FormFieldProps {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Standard form field wrapper: label + control slot + optional hint/error.
 * Errors are wired via aria-describedby / aria-invalid on the control
 * (use getFormFieldA11yProps) so messaging is not colour-only (#678).
 */
export function FormField({
  id,
  label,
  error,
  hint,
  required,
  children,
  className,
}: FormFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const invalid = Boolean(error);

  return (
    <div
      className={`form-field${invalid ? ' form-field--invalid' : ''}${className ? ` ${className}` : ''}`}
      data-invalid={invalid || undefined}
    >
      <label htmlFor={id} className="form-field__label">
        {label}
        {required ? (
          <span className="form-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={hintId} className="form-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? <FormFieldError id={errorId}>{error}</FormFieldError> : null}
    </div>
  );
}

/** Aria props to spread onto the associated input/select/textarea. */
export function getFormFieldA11yProps(id: string, error?: string | null, hint?: string) {
  const describedBy: string[] = [];
  if (error) describedBy.push(`${id}-error`);
  else if (hint) describedBy.push(`${id}-hint`);

  return {
    id,
    'aria-invalid': Boolean(error) || undefined,
    'aria-describedby': describedBy.length > 0 ? describedBy.join(' ') : undefined,
  } as const;
}

export type FormInputProps = InputHTMLAttributes<HTMLInputElement> & {
  fieldId: string;
  error?: string | null;
  hint?: string;
};

export function FormInput({ fieldId, error, hint, className, ...rest }: FormInputProps) {
  const a11y = getFormFieldA11yProps(fieldId, error, hint);
  return (
    <input
      {...rest}
      {...a11y}
      className={`form-field__control${error ? ' form-field__control--invalid' : ''}${className ? ` ${className}` : ''}`}
    />
  );
}

export type FormTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  fieldId: string;
  error?: string | null;
  hint?: string;
};

export function FormTextarea({ fieldId, error, hint, className, ...rest }: FormTextareaProps) {
  const a11y = getFormFieldA11yProps(fieldId, error, hint);
  return (
    <textarea
      {...rest}
      {...a11y}
      className={`form-field__control${error ? ' form-field__control--invalid' : ''}${className ? ` ${className}` : ''}`}
    />
  );
}

export type FormSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  fieldId: string;
  error?: string | null;
  hint?: string;
};

export function FormSelect({ fieldId, error, hint, className, children, ...rest }: FormSelectProps) {
  const a11y = getFormFieldA11yProps(fieldId, error, hint);
  return (
    <select
      {...rest}
      {...a11y}
      className={`form-field__control${error ? ' form-field__control--invalid' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </select>
  );
}
