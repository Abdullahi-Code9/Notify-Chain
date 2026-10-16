import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SyncStatus } from './SyncStatus';
import { useEventStore } from '../store/eventStore';

describe('SyncStatus', () => {
  it('renders last sync timestamp and error state', () => {
    useEventStore.setState({
      lastSuccessfulSyncAt: Date.now(),
      lastSyncFailureAt: Date.now(),
      lastSyncError: 'Background refresh failed',
      isLoading: false,
    });

    render(<SyncStatus />);
    expect(screen.getByText(/Last sync:/)).toBeInTheDocument();
    expect(screen.getByText('refresh failed')).toBeInTheDocument();
  });

  it('shows loading state during initial sync', () => {
    useEventStore.setState({
      lastSuccessfulSyncAt: null,
      lastSyncFailureAt: null,
      lastSyncError: null,
      isLoading: true,
    });

    render(<SyncStatus />);
    expect(screen.getByText('Syncing...')).toBeInTheDocument();
    expect(screen.getByTitle('Synchronizing event data...')).toBeInTheDocument();
  });

  it('hides component when never synced and not loading', () => {
    useEventStore.setState({
      lastSuccessfulSyncAt: null,
      lastSyncFailureAt: null,
      lastSyncError: null,
      isLoading: false,
    });

    const { container } = render(<SyncStatus />);
    expect(container.firstChild).toBeNull();
  });
});
