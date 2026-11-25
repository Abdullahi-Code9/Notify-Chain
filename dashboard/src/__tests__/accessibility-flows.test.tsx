import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { ExportHistoryPage } from '../pages/ExportHistoryPage';
import { NotificationSearchPage } from '../pages/NotificationSearchPage';
import { Modal } from '../components/Modal';
import { searchNotifications } from '../services/eventsApi';
import type { NotificationSearchResponse } from '../services/eventsApi';
import { downloadBlob } from '../utils/notificationExport';

expect.extend(toHaveNoViolations);

// Mock external boundaries, preserving actual page and shared-component markup.
jest.mock('../services/wallet', () => ({
  connectWallet: jest.fn(),
  disconnectWallet: jest.fn(),
}));
jest.mock('../services/eventsApi', () => ({
  searchNotifications: jest.fn(),
  isListenerApiTimeoutError: () => false,
}));
jest.mock('../utils/notificationExport', () => ({
  ...jest.requireActual('../utils/notificationExport'),
  downloadBlob: jest.fn(),
}));

const mockedSearch = jest.mocked(searchNotifications);
const response: NotificationSearchResponse = {
  results: [{
    id: 1,
    source: 'scheduled',
    status: 'PENDING',
    notificationType: 'email',
    targetRecipient: 'reader@example.com',
    eventId: 'event-accessibility',
    txHash: 'transaction-accessibility',
    contractAddress: 'contract-accessibility',
    createdAt: '2026-01-15T12:00:00.000Z',
    payload: null,
    failureReason: null,
  }],
  total: 21,
  limit: 20,
  offset: 0,
  itemCount: 1,
  totalPages: 2,
};

beforeEach(() => {
  // axe requires real timers; debounce and loading transitions run normally.
  jest.useRealTimers();
  mockedSearch.mockReset();
  mockedSearch.mockResolvedValue(response);
  jest.mocked(downloadBlob).mockClear();
});

test('export history: loaded table, pagination, filtering and empty-state recovery', async () => {
  const user = userEvent.setup();
  const { container } = render(<ExportHistoryPage />);
  await screen.findByRole('table', {}, { timeout: 2000 });
  expect(await axe(container)).toHaveNoViolations();

  await user.click(screen.getByRole('button', { name: 'Next', exact: true }));
  expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();

  await user.selectOptions(screen.getByLabelText('Status'), 'failed');
  expect(screen.getByText('User activity digest export')).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();

  await user.type(screen.getByLabelText('Search Exports'), 'no-matching-export');
  expect(screen.getByRole('heading', { name: 'No export records found' })).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();

  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getByRole('table')).toBeInTheDocument();
  expect(screen.getByLabelText('Search Exports')).toHaveValue('');
});

test('notification search: initial state, filtered results, pagination, empty and error feedback', async () => {
  const user = userEvent.setup();
  const { container } = render(<NotificationSearchPage />);
  expect(screen.getByRole('heading', { name: 'Start searching' })).toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();

  await user.selectOptions(screen.getByLabelText('Filter by notification type'), 'email');
  await screen.findByText('reader@example.com');
  expect(mockedSearch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ type: 'email' }));
  expect(await axe(container)).toHaveNoViolations();

  await user.click(screen.getByRole('button', { name: 'Next page' }));
  await waitFor(() => expect(mockedSearch).toHaveBeenLastCalledWith(
    expect.any(String), expect.objectContaining({ offset: 20 }),
  ));
  await screen.findByText('reader@example.com');
  expect(await axe(container)).toHaveNoViolations();

  mockedSearch.mockResolvedValue({ ...response, results: [], total: 0, totalPages: 0, itemCount: 0 });
  await user.selectOptions(screen.getByLabelText('Filter by delivery status'), 'FAILED');
  await screen.findByRole('heading', { name: 'No notifications match your search' });
  expect(await axe(container)).toHaveNoViolations();

  mockedSearch.mockRejectedValue(new Error('Search service unavailable'));
  await user.selectOptions(screen.getByLabelText('Filter by delivery status'), 'PENDING');
  expect(await screen.findByRole('alert')).toHaveTextContent('Search service unavailable');
  expect(await axe(container)).toHaveNoViolations();

  await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
  expect(screen.getByRole('heading', { name: 'Start searching' })).toBeInTheDocument();
});

test('dialog: keyboard opening, focus containment, Escape and focus restoration', async () => {
  function DialogFlow() {
    const [open, setOpen] = useState(false);
    return <main>
      <h1>Notification details</h1>
      <button type="button" onClick={() => setOpen(true)}>Open details</button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Delivery details">
        <button type="button">Retry delivery</button>
      </Modal>
    </main>;
  }
  const user = userEvent.setup();
  const { container } = render(<DialogFlow />);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Open details' })).toHaveFocus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog', { name: 'Delivery details' });
  expect(within(dialog).getByRole('button', { name: 'Close modal' })).toHaveFocus();
  expect(await axe(container)).toHaveNoViolations();
  await user.tab({ shift: true });
  expect(within(dialog).getByRole('button', { name: 'Retry delivery' })).toHaveFocus();
  await user.tab();
  expect(within(dialog).getByRole('button', { name: 'Close modal' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details' })).toHaveFocus();
});

test('notification export exposes completion feedback and keeps an accessible format selector', async () => {
  mockedSearch.mockResolvedValue({ ...response, total: 1, totalPages: 1 });
  const user = userEvent.setup();
  const { container } = render(<NotificationSearchPage />);
  const exportButton = screen.getByRole('button', { name: 'Export filtered notifications' });
  expect(exportButton).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Filter by notification type'), 'email');
  await screen.findByText('reader@example.com');
  await user.selectOptions(screen.getByLabelText('Export format'), 'csv');
  await user.click(exportButton);
  expect(await screen.findByRole('status')).toHaveTextContent('Exported 1 notification as CSV.');
  expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/\.csv$/));
  expect(await axe(container)).toHaveNoViolations();
});
