import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CommandPalette } from './CommandPalette';

function renderPalette() {
  const props = {
    isOpen: true,
    onClose: jest.fn(),
    onSelectTab: jest.fn(),
    onToggleTheme: jest.fn(),
    onShowShortcuts: jest.fn(),
  };
  return { ...render(<CommandPalette {...props} />), props };
}

describe('CommandPalette', () => {
  it('searches and navigates to available dashboard sections', () => {
    const { props } = renderPalette();
    const search = screen.getByRole('combobox', { name: 'Search dashboard commands' });

    fireEvent.change(search, { target: { value: 'preferences' } });
    expect(screen.getByRole('option', { name: /Preferences/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Event Explorer/ })).not.toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onSelectTab).toHaveBeenCalledWith('preferences');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('supports arrow navigation and frequent dashboard actions', () => {
    const { props } = renderPalette();
    const search = screen.getByRole('combobox', { name: 'Search dashboard commands' });

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onSelectTab).toHaveBeenCalledWith('timeline');

    fireEvent.change(search, { target: { value: 'toggle theme' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onToggleTheme).toHaveBeenCalled();
  });

  it('closes on Escape and reports queries with no available actions', () => {
    const { props } = renderPalette();
    const search = screen.getByRole('combobox', { name: 'Search dashboard commands' });

    fireEvent.change(search, { target: { value: 'not available' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching commands.');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });
});
