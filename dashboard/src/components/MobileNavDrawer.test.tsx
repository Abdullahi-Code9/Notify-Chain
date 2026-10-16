/**
 * Tests for MobileNavDrawer (#396)
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MobileNavDrawer, NAV_ITEMS } from '../components/MobileNavDrawer';

const defaultProps = {
  isOpen: true,
  onClose: jest.fn(),
  activeTab: 'explorer' as const,
  onSelectTab: jest.fn(),
};

describe('MobileNavDrawer (#396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    render(<MobileNavDrawer {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the drawer dialog when open', () => {
    render(<MobileNavDrawer {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has aria-modal="true" on the dialog', () => {
    render(<MobileNavDrawer {...defaultProps} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('has accessible label on the dialog', () => {
    render(<MobileNavDrawer {...defaultProps} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Navigation menu');
  });

  it('renders all nav items', () => {
    render(<MobileNavDrawer {...defaultProps} />);
    for (const item of NAV_ITEMS) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it('marks the active tab with aria-current="page"', () => {
    render(<MobileNavDrawer {...defaultProps} activeTab="timeline" />);
    const activeBtn = screen.getByText('Delivery Timeline').closest('button');
    expect(activeBtn).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark inactive tabs with aria-current', () => {
    render(<MobileNavDrawer {...defaultProps} activeTab="timeline" />);
    const inactiveBtn = screen.getByText('Event Explorer').closest('button');
    expect(inactiveBtn).not.toHaveAttribute('aria-current');
  });

  it('calls onSelectTab and onClose when a nav item is clicked', () => {
    const onSelectTab = jest.fn();
    const onClose = jest.fn();
    render(<MobileNavDrawer {...defaultProps} onSelectTab={onSelectTab} onClose={onClose} />);
    fireEvent.click(screen.getByText('Delivery Timeline'));
    expect(onSelectTab).toHaveBeenCalledWith('timeline');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = jest.fn();
    render(<MobileNavDrawer {...defaultProps} onClose={onClose} />);
    const closeBtn = screen.getByLabelText('Close navigation menu');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = jest.fn();
    render(<MobileNavDrawer {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = jest.fn();
    const { container } = render(<MobileNavDrawer {...defaultProps} onClose={onClose} />);
    const backdrop = container.querySelector('.mobile-drawer__backdrop');
    expect(backdrop).toBeInTheDocument();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders navigation groups', () => {
    render(<MobileNavDrawer {...defaultProps} />);
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Search & Config')).toBeInTheDocument();
  });

  it('has a nav landmark with accessible label', () => {
    render(<MobileNavDrawer {...defaultProps} />);
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(nav).toBeInTheDocument();
  });
});
