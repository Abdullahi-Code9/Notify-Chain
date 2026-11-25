import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { NAV_ITEMS, type Tab } from './MobileNavDrawer';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTab: (tab: Tab) => void;
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
}

interface Command {
  id: string;
  label: string;
  group: string;
  action: () => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  onSelectTab,
  onToggleTheme,
  onShowShortcuts,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const commands = useMemo<Command[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({
        id: item.id,
        label: item.label,
        group: item.group ?? 'Dashboard',
        action: () => onSelectTab(item.id),
      })),
      {
        id: 'toggle-theme',
        label: 'Toggle theme',
        group: 'Actions',
        action: onToggleTheme,
      },
      {
        id: 'keyboard-shortcuts',
        label: 'Keyboard shortcuts',
        group: 'Actions',
        action: onShowShortcuts,
      },
    ],
    [onSelectTab, onToggleTheme, onShowShortcuts],
  );

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(normalizedQuery) ||
        command.group.toLowerCase().includes(normalizedQuery),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    setQuery('');
    setActiveIndex(0);
  }, [isOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!isOpen) return null;

  const selectCommand = (command: Command) => {
    command.action();
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown' && filteredCommands.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % filteredCommands.length);
    } else if (event.key === 'ArrowUp' && filteredCommands.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (event.key === 'Enter' && filteredCommands[activeIndex]) {
      event.preventDefault();
      selectCommand(filteredCommands[activeIndex]);
    }
  };

  return (
    <div
      className="command-palette__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <label className="sr-only" htmlFor="command-palette-search">
          Search dashboard commands
        </label>
        <input
          ref={inputRef}
          id="command-palette-search"
          className="command-palette__search"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-palette-options"
          aria-activedescendant={
            filteredCommands[activeIndex]
              ? `command-palette-option-${filteredCommands[activeIndex].id}`
              : undefined
          }
          placeholder="Search pages and actions..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div
          id="command-palette-options"
          className="command-palette__options"
          role="listbox"
          aria-label="Dashboard commands"
        >
          {filteredCommands.map((command, index) => (
            <button
              key={command.id}
              id={`command-palette-option-${command.id}`}
              className="command-palette__option"
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectCommand(command)}
            >
              <span>
                <span className="command-palette__label">{command.label}</span>
                <span className="command-palette__group">{command.group}</span>
              </span>
              {activeIndex === index && <kbd>↵</kbd>}
            </button>
          ))}
          {filteredCommands.length === 0 && (
            <p className="command-palette__empty" role="status">
              No matching commands.
            </p>
          )}
        </div>
        <p className="command-palette__hint">
          <kbd>↑</kbd> <kbd>↓</kbd> to navigate <span>·</span> <kbd>Enter</kbd> to open{' '}
          <span>·</span> <kbd>Esc</kbd> to close
        </p>
      </section>
    </div>
  );
}
