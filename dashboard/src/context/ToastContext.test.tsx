/**
 * Tests for ToastContext (#397)
 */
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToastProvider, useToast } from '../context/ToastContext';

interface ToastTriggerProps {
  message?: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

// Helper component that exposes toast actions
function ToastTrigger({
  message = 'Test message',
  variant = 'success' as const,
  duration = 0,
}: ToastTriggerProps) {
  const { addToast, removeToast, showSuccess, showError, showInfo, showWarning, toasts } =
    useToast();
  return (
    <div>
      <button onClick={() => addToast(message, variant, duration)} data-testid="add">
        Add Toast
      </button>
      <button onClick={() => showSuccess('Success!')} data-testid="success">
        Success
      </button>
      <button onClick={() => showError('Error!')} data-testid="error">
        Error
      </button>
      <button onClick={() => showInfo('Info!')} data-testid="info">
        Info
      </button>
      <button onClick={() => showWarning('Warning!')} data-testid="warning">
        Warning
      </button>
      {toasts.map((t) => (
        <button key={t.id} onClick={() => removeToast(t.id)} data-testid={`remove-${t.id}`}>
          Remove {t.id}
        </button>
      ))}
    </div>
  );
}

describe('ToastProvider (#397)', () => {
  it('renders children without crashing', () => {
    render(
      <ToastProvider>
        <div data-testid="child">Hello</div>
      </ToastProvider>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('adds a toast and renders it in the viewport', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('add'));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('toast--success');
    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('renders success toast with correct class', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('success'));
    expect(screen.getByText('Success!')).toBeInTheDocument();
    const toast = screen.getByRole('status');
    expect(toast).toHaveClass('toast--success');
  });

  it('renders error toast with correct class', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('error'));
    expect(screen.getByText('Error!')).toBeInTheDocument();
    const toast = screen.getByRole('status');
    expect(toast).toHaveClass('toast--error');
  });

  it('renders info and warning toasts', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('info'));
    expect(screen.getByText('Info!')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('warning'));
    expect(screen.getByText('Warning!')).toBeInTheDocument();
  });

  it('dismisses toast on close button click', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('add'));
    const closeBtn = screen.getByLabelText(/dismiss success notification/i);
    fireEvent.click(closeBtn);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('auto-dismisses toast after duration', () => {
    jest.useFakeTimers();
    render(
      <ToastProvider>
        <ToastTrigger duration={1000} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('add'));
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1001);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    jest.useRealTimers();
  });

  it('does not auto-dismiss when duration is 0', () => {
    jest.useFakeTimers();
    render(
      <ToastProvider>
        <ToastTrigger duration={0} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('add'));
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('uses aria-live="polite" for success toasts', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('success'));
    const politeRegion = document.querySelector('[aria-live="polite"]');
    expect(politeRegion).toBeInTheDocument();
    expect(politeRegion?.textContent).toContain('Success!');
  });

  it('uses aria-live="assertive" for error toasts', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('error'));
    const assertiveRegion = document.querySelector('[aria-live="assertive"]');
    expect(assertiveRegion).toBeInTheDocument();
    expect(assertiveRegion?.textContent).toContain('Error!');
  });

  it('throws when useToast is used outside provider', () => {
    // Suppress console.error for this test
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    function BadComponent() {
      useToast();
      return null;
    }
    expect(() => render(<BadComponent />)).toThrow(
      'useToast must be used within a <ToastProvider>',
    );
    consoleError.mockRestore();
  });
});
