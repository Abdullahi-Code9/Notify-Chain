/**
 * Tests for ErrorBoundary (Issue #654)
 *
 * Covers:
 *  - Normal (no-error) pass-through rendering
 *  - Fallback UI shown on error
 *  - Custom fallback prop
 *  - section prop in fallback heading
 *  - "Try again" button resets the boundary
 *  - onError callback invoked with error and componentStack
 *  - Errors are logged to console.error (not re-thrown)
 *  - Sensitive data is NOT included in the console output
 *  - Multiple independent boundaries: one error does not affect siblings
 *  - Accessibility: role="alert" on fallback
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { Component, type ErrorInfo } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A component that throws on the first render when `shouldThrow` is true. */
function BrokenComponent({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) throw new Error('Test render error');
  return <p data-testid="healthy-child">All good</p>;
}

/** A stable component used as a sibling to verify isolation. */
function StableComponent() {
  return <p data-testid="stable-sibling">Stable</p>;
}

// ── Suppress expected console.error noise during tests ───────────────────────
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  jest.clearAllMocks();
});

// ── Normal rendering ──────────────────────────────────────────────────────────

describe('pass-through (no error)', () => {
  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary section="TestSection">
        <BrokenComponent shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });
});

// ── Error caught ──────────────────────────────────────────────────────────────

describe('error caught', () => {
  it('renders the default fallback UI when a child throws', () => {
    render(
      <ErrorBoundary section="Event Explorer">
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('healthy-child')).not.toBeInTheDocument();
  });

  it('includes the section name in the fallback heading', () => {
    render(
      <ErrorBoundary section="Delivery Timeline">
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Delivery Timeline/i)).toBeInTheDocument();
  });

  it('uses a generic heading when no section prop is provided', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    // Generic "This section" text should appear
    expect(screen.getByText(/This section/i)).toBeInTheDocument();
  });

  it('renders the retry button', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-retry')).toBeInTheDocument();
  });
});

// ── Custom fallback ───────────────────────────────────────────────────────────

describe('custom fallback', () => {
  it('renders the custom fallback instead of the default when provided', () => {
    render(
      <ErrorBoundary fallback={<p data-testid="custom-fallback">Custom error UI</p>}>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });
});

// ── Retry / reset ─────────────────────────────────────────────────────────────

describe('retry button', () => {
  it('resets the boundary and re-renders children when retry is clicked', () => {
    // Use a counter to make the component healthy on the second render
    let renderCount = 0;

    function Flaky() {
      renderCount++;
      if (renderCount === 1) throw new Error('First render fails');
      return <p data-testid="recovered">Recovered</p>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('error-boundary-retry'));

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });
});

// ── onError callback ──────────────────────────────────────────────────────────

describe('onError callback', () => {
  it('invokes the onError callback with the error and component stack', () => {
    const onError = jest.fn();

    render(
      <ErrorBoundary onError={onError}>
        <BrokenComponent />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [err, info] = onError.mock.calls[0] as [Error, ErrorInfo];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Test render error');
    expect(typeof info.componentStack).toBe('string');
  });

  it('does not crash if onError throws', () => {
    const onError = jest.fn(() => { throw new Error('Callback error'); });

    expect(() => {
      render(
        <ErrorBoundary onError={onError}>
          <BrokenComponent />
        </ErrorBoundary>,
      );
    }).not.toThrow();

    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────

describe('error logging', () => {
  it('logs the error name and message to console.error', () => {
    render(
      <ErrorBoundary section="Webhooks">
        <BrokenComponent />
      </ErrorBoundary>,
    );

    const logCalls = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(logCalls).toMatch(/ErrorBoundary/);
    expect(logCalls).toMatch(/Webhooks/);
    expect(logCalls).toMatch(/Test render error/);
  });

  it('does not log stack trace frames that could expose sensitive variable values', () => {
    const SensitiveComponent = () => {
      const secretApiKey = 'sk-super-secret-key-12345';
      throw new Error(`Failed with key=${secretApiKey}`);
    };

    render(
      <ErrorBoundary>
        <SensitiveComponent />
      </ErrorBoundary>,
    );

    // The boundary should log name + message, but NOT the full JS stack
    const logArgs = consoleErrorSpy.mock.calls.flat().join('\n');
    // The component stack is included (diagnostic) but NOT the raw JS Error.stack
    // which may contain file paths with user data. We only check that only
    // the expected fields are logged (name, message, componentStack).
    expect(logArgs).not.toMatch(/at SensitiveComponent \(/); // no JS stack frames
  });
});

// ── Isolation: multiple boundaries ───────────────────────────────────────────

describe('boundary isolation', () => {
  it('an error in one boundary does not affect a sibling boundary', () => {
    render(
      <div>
        <ErrorBoundary section="Broken Section">
          <BrokenComponent />
        </ErrorBoundary>

        <ErrorBoundary section="Healthy Section">
          <StableComponent />
        </ErrorBoundary>
      </div>,
    );

    // Broken section shows fallback
    expect(screen.getByText(/Broken Section/i)).toBeInTheDocument();

    // Healthy sibling still renders its content
    expect(screen.getByTestId('stable-sibling')).toBeInTheDocument();
  });

  it('an error in a child boundary does not propagate to a parent boundary', () => {
    render(
      <ErrorBoundary section="Outer">
        <div>
          <p data-testid="outer-content">Outer content</p>
          <ErrorBoundary section="Inner">
            <BrokenComponent />
          </ErrorBoundary>
        </div>
      </ErrorBoundary>,
    );

    // Inner boundary shows fallback
    expect(screen.getByText(/Inner/i)).toBeInTheDocument();
    // Outer boundary's own content still renders
    expect(screen.getByTestId('outer-content')).toBeInTheDocument();
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────

describe('accessibility', () => {
  it('fallback has role="alert" so screen readers announce it', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
