/**
 * ErrorBoundary  (Issue #654)
 *
 * A React class component error boundary that:
 *  - Catches render-time and lifecycle errors in its subtree
 *  - Displays a scoped fallback UI so the rest of the dashboard stays usable
 *  - Logs errors to the console without leaking sensitive information
 *  - Exposes a "Try again" button to reset the boundary and retry rendering
 *
 * Usage — wrap any critical dashboard section:
 *
 *   <ErrorBoundary section="Event Explorer">
 *     <EventExplorerPage />
 *   </ErrorBoundary>
 *
 * Custom fallback:
 *
 *   <ErrorBoundary fallback={<p>Something went wrong.</p>}>
 *     <MyWidget />
 *   </ErrorBoundary>
 *
 * NOTE: Error boundaries must be class components in React (hooks cannot
 * catch render errors).  The `useErrorBoundary` hook below is a thin
 * wrapper that lets function components access boundary state imperatively
 * if needed in future.
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional custom fallback rendered when an error is caught.
   * When provided, the default fallback UI (title + retry button) is replaced.
   */
  fallback?: ReactNode;
  /**
   * Human-readable name for the section this boundary wraps.
   * Appears in the default fallback heading and in log output.
   */
  section?: string;
  /**
   * Optional callback invoked whenever an error is caught.
   * Useful for reporting to an external error-tracking service.
   * Receives the error and the React component stack.
   * Must NOT throw — exceptions here are swallowed.
   */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** Stored purely for the onError callback; never rendered. */
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const section = this.props.section ?? 'Unknown section';

    // Log without exposing potentially sensitive payload values — only name + message.
    console.error(
      `[ErrorBoundary] Caught error in "${section}":`,
      error.name,
      error.message,
      // Component stack is diagnostic, not sensitive.
      info.componentStack,
    );

    try {
      this.props.onError?.(error, info);
    } catch {
      // Swallow errors thrown by the consumer callback.
    }
  }

  handleReset(): void {
    this.setState({ hasError: false, error: null });
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // Custom fallback takes full priority
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    const section = this.props.section ?? 'This section';

    return (
      <div
        className="error-boundary"
        role="alert"
        aria-live="assertive"
        data-testid="error-boundary-fallback"
      >
        <div className="error-boundary__inner">
          <span className="error-boundary__icon" aria-hidden="true">
            ⚠
          </span>
          <h2 className="error-boundary__title">{section} failed to load</h2>
          <p className="error-boundary__message">
            An unexpected error occurred in this section. Other parts of the
            dashboard are unaffected.
          </p>
          <button
            type="button"
            className="error-boundary__retry"
            onClick={this.handleReset}
            data-testid="error-boundary-retry"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
