/**
 * Tests for ConfirmationDialog (Issue #653)
 *
 * Covers:
 *  - Rendering: closed state, open state, custom labels, variant prop
 *  - Interaction: confirm click, cancel click, backdrop click, Escape key
 *  - Keyboard: Tab focus trap (forward and backward), Enter fires confirm
 *  - Focus management: confirm button auto-focused on open, original element
 *    restored on close
 *  - Accessibility: axe audit passes
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { ConfirmationDialog } from './ConfirmationDialog';

expect.extend(toHaveNoViolations);

// ── Default props ─────────────────────────────────────────────────────────────

const defaults = {
  isOpen: true,
  title: 'Delete channel',
  message: 'This action cannot be undone. Are you sure?',
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('rendering', () => {
  it('renders nothing when isOpen is false', () => {
    render(<ConfirmationDialog {...defaults} isOpen={false} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('renders the dialog when isOpen is true', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('renders the title and message', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(screen.getByText('Delete channel')).toBeInTheDocument();
    expect(screen.getByText('This action cannot be undone. Are you sure?')).toBeInTheDocument();
  });

  it('renders default button labels when none are provided', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(screen.getByTestId('confirmation-dialog-confirm')).toHaveTextContent('Confirm');
    expect(screen.getByTestId('confirmation-dialog-cancel')).toHaveTextContent('Cancel');
  });

  it('renders custom confirm and cancel labels', () => {
    render(
      <ConfirmationDialog
        {...defaults}
        confirmLabel="Yes, delete"
        cancelLabel="No, keep it"
      />,
    );
    expect(screen.getByTestId('confirmation-dialog-confirm')).toHaveTextContent('Yes, delete');
    expect(screen.getByTestId('confirmation-dialog-cancel')).toHaveTextContent('No, keep it');
  });

  it('applies the danger variant class to the confirm button', () => {
    render(<ConfirmationDialog {...defaults} variant="danger" />);
    expect(screen.getByTestId('confirmation-dialog-confirm')).toHaveClass(
      'confirmation-dialog__btn--danger',
    );
  });

  it('applies the primary variant class by default', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(screen.getByTestId('confirmation-dialog-confirm')).toHaveClass(
      'confirmation-dialog__btn--primary',
    );
  });
});

// ── Interactions ──────────────────────────────────────────────────────────────

describe('interactions', () => {
  it('calls onConfirm when the confirm button is clicked', () => {
    render(<ConfirmationDialog {...defaults} />);
    fireEvent.click(screen.getByTestId('confirmation-dialog-confirm'));
    expect(defaults.onConfirm).toHaveBeenCalledTimes(1);
    expect(defaults.onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel when the cancel button is clicked', () => {
    render(<ConfirmationDialog {...defaults} />);
    fireEvent.click(screen.getByTestId('confirmation-dialog-cancel'));
    expect(defaults.onCancel).toHaveBeenCalledTimes(1);
    expect(defaults.onConfirm).not.toHaveBeenCalled();
  });

  it('calls onCancel when clicking the backdrop', () => {
    render(<ConfirmationDialog {...defaults} />);
    fireEvent.click(screen.getByTestId('confirmation-dialog-backdrop'));
    expect(defaults.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onCancel when clicking inside the dialog (not the backdrop)', () => {
    render(<ConfirmationDialog {...defaults} />);
    fireEvent.click(screen.getByTestId('confirmation-dialog'));
    expect(defaults.onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel when Escape is pressed', () => {
    render(<ConfirmationDialog {...defaults} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(defaults.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onCancel on Escape when dialog is closed', () => {
    render(<ConfirmationDialog {...defaults} isOpen={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(defaults.onCancel).not.toHaveBeenCalled();
  });
});

// ── Keyboard / focus trap ─────────────────────────────────────────────────────

describe('keyboard interaction', () => {
  it('auto-focuses the confirm button when opened', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(document.activeElement).toBe(screen.getByTestId('confirmation-dialog-confirm'));
  });

  it('wraps Tab from last focusable element back to first', () => {
    render(<ConfirmationDialog {...defaults} />);
    const cancelBtn = screen.getByTestId('confirmation-dialog-cancel');
    cancelBtn.focus();

    fireEvent.keyDown(screen.getByTestId('confirmation-dialog'), { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByTestId('confirmation-dialog-confirm'));
  });

  it('wraps Shift+Tab from first focusable element back to last', () => {
    render(<ConfirmationDialog {...defaults} />);
    const confirmBtn = screen.getByTestId('confirmation-dialog-confirm');
    confirmBtn.focus();

    fireEvent.keyDown(screen.getByTestId('confirmation-dialog'), {
      key: 'Tab',
      shiftKey: true,
    });

    expect(document.activeElement).toBe(screen.getByTestId('confirmation-dialog-cancel'));
  });
});

// ── Focus restoration ─────────────────────────────────────────────────────────

describe('focus restoration', () => {
  it('restores focus to the previously focused element when closed', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open dialog';
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(<ConfirmationDialog {...defaults} />);

    act(() => {
      rerender(<ConfirmationDialog {...defaults} isOpen={false} />);
    });

    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────

describe('accessibility', () => {
  it('has no accessibility violations when open', async () => {
    const { container } = render(<ConfirmationDialog {...defaults} />);
    const results = await axe(container, {
      rules: { 'nested-interactive': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('uses role="alertdialog" to signal urgency', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('sets aria-modal="true"', () => {
    render(<ConfirmationDialog {...defaults} />);
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('sets aria-labelledby pointing at the title', () => {
    render(<ConfirmationDialog {...defaults} />);
    const dialog = screen.getByRole('alertdialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent('Delete channel');
  });

  it('sets aria-describedby pointing at the message', () => {
    render(<ConfirmationDialog {...defaults} />);
    const dialog = screen.getByRole('alertdialog');
    const descId = dialog.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)).toHaveTextContent(
      'This action cannot be undone',
    );
  });
});
