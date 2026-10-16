/**
 * Keyboard shortcuts tests (#505)
 *
 * Tests for the useKeyboardShortcuts hook and KeyboardShortcutsHelp component.
 */
import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { KeyboardShortcutsHelp } from '../components/KeyboardShortcutsHelp';

// ─── useKeyboardShortcuts hook tests ────────────────────────────────────────

function ShortcutTestHarness({
  onTabChange,
  onToggleTheme,
  onRefresh,
}: {
  onTabChange: (tab: string) => void;
  onToggleTheme: () => void;
  onRefresh?: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);

  useKeyboardShortcuts({
    activeTab: 'explorer',
    onTabChange,
    onToggleTheme,
    onRefresh,
    helpOpen,
    onToggleHelp: () => setHelpOpen((prev) => !prev),
    onCloseHelp: () => setHelpOpen(false),
  });

  return (
    <div>
      <div data-testid="help-status">{helpOpen ? 'open' : 'closed'}</div>
      <KeyboardShortcutsHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

describe('useKeyboardShortcuts (#505)', () => {
  it('switches tab when number key 1-9 is pressed', () => {
    const onTabChange = jest.fn();
    render(
      <ShortcutTestHarness onTabChange={onTabChange} onToggleTheme={jest.fn()} />,
    );

    fireEvent.keyDown(document, { key: '1' });
    expect(onTabChange).toHaveBeenCalledWith('explorer');

    fireEvent.keyDown(document, { key: '2' });
    expect(onTabChange).toHaveBeenCalledWith('timeline');

    fireEvent.keyDown(document, { key: '3' });
    expect(onTabChange).toHaveBeenCalledWith('activity');
  });

  it('toggles theme when T is pressed', () => {
    const onToggleTheme = jest.fn();
    render(
      <ShortcutTestHarness onTabChange={jest.fn()} onToggleTheme={onToggleTheme} />,
    );

    fireEvent.keyDown(document, { key: 't' });
    expect(onToggleTheme).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'T' });
    expect(onToggleTheme).toHaveBeenCalledTimes(2);
  });

  it('triggers refresh when R is pressed', () => {
    const onRefresh = jest.fn();
    render(
      <ShortcutTestHarness
        onTabChange={jest.fn()}
        onToggleTheme={jest.fn()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.keyDown(document, { key: 'r' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not trigger shortcuts when typing in an input', () => {
    const onTabChange = jest.fn();
    const { getByTestId } = render(
      <div>
        <ShortcutTestHarness onTabChange={onTabChange} onToggleTheme={jest.fn()} />
        <input data-testid="test-input" />
      </div>,
    );

    const input = getByTestId('test-input');
    input.focus();
    fireEvent.keyDown(input, { key: '1' });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('does not trigger shortcuts when modifier keys are held', () => {
    const onTabChange = jest.fn();
    render(
      <ShortcutTestHarness onTabChange={onTabChange} onToggleTheme={jest.fn()} />,
    );

    fireEvent.keyDown(document, { key: '1', ctrlKey: true });
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: '1', altKey: true });
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: '1', metaKey: true });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('does not trigger shortcuts when help overlay is open', () => {
    const onTabChange = jest.fn();
    const { getByTestId } = render(
      <ShortcutTestHarness onTabChange={onTabChange} onToggleTheme={jest.fn()} />,
    );

    // Open help
    fireEvent.keyDown(document, { key: '?' });
    expect(getByTestId('help-status')).toHaveTextContent('open');

    // Now number keys should not change tab
    fireEvent.keyDown(document, { key: '2' });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('Escape closes help overlay', () => {
    const { getByTestId } = render(
      <ShortcutTestHarness onTabChange={jest.fn()} onToggleTheme={jest.fn()} />,
    );

    // Open help
    fireEvent.keyDown(document, { key: '?' });
    expect(getByTestId('help-status')).toHaveTextContent('open');

    // Close with Escape
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(getByTestId('help-status')).toHaveTextContent('closed');
  });

  it('does nothing for number keys beyond NAV_ITEMS length', () => {
    const onTabChange = jest.fn();
    render(
      <ShortcutTestHarness onTabChange={onTabChange} onToggleTheme={jest.fn()} />,
    );

    // Key 0 should not trigger tab change
    fireEvent.keyDown(document, { key: '0' });
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

// ─── KeyboardShortcutsHelp component tests ──────────────────────────────────

describe('KeyboardShortcutsHelp component (#505)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <KeyboardShortcutsHelp isOpen={false} onClose={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the help dialog when open', () => {
    const { getByLabelText } = render(
      <KeyboardShortcutsHelp isOpen={true} onClose={jest.fn()} />,
    );
    const dialog = getByLabelText('Keyboard shortcuts');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('displays all shortcut keys', () => {
    const { getByText } = render(
      <KeyboardShortcutsHelp isOpen={true} onClose={jest.fn()} />,
    );

    expect(getByText('Event Explorer')).toBeInTheDocument();
    expect(getByText('Toggle theme (dark/light)')).toBeInTheDocument();
    expect(getByText('Refresh events')).toBeInTheDocument();
    expect(getByText('Show/hide this help')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    const { getByLabelText } = render(
      <KeyboardShortcutsHelp isOpen={true} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText('Close keyboard shortcuts'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has accessible structure', async () => {
    const { container } = render(
      <KeyboardShortcutsHelp isOpen={true} onClose={jest.fn()} />,
    );
    const { axe, toHaveNoViolations } = await import('jest-axe');
    expect.extend(toHaveNoViolations);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
