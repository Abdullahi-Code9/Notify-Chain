import '@testing-library/jest-dom';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import { NotificationSearchPage } from './NotificationSearchPage';
import { searchNotifications } from '../services/eventsApi';
import type { NotificationSearchResponse } from '../services/eventsApi';

jest.mock('../services/eventsApi', () => {
  const actual = jest.requireActual(
    '../services/eventsApi',
  ) as typeof import('../services/eventsApi');

  return {
    ...actual,
    searchNotifications: jest.fn(),
  };
});

const mockedSearch =
  searchNotifications as jest.MockedFunction<
    typeof searchNotifications
  >;

function emptyResponse(): NotificationSearchResponse {
  return {
    results: [],
    total: 0,
    limit: 20,
    offset: 0,
    itemCount: 0,
    totalPages: 0,
  };
}

const mockResult: NotificationSearchResponse = {
  results: [
    {
      id: 1,
      source: 'scheduled',
      eventId: 'evt-abc',
      txHash: '0xdeadbeef',
      contractAddress: 'CABCDEF',
      notificationType: 'email',
      targetRecipient: 'user@example.com',
      status: 'PENDING',
      createdAt: '2026-01-15T12:00:00.000Z',
      payload: null,
      failureReason: null,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
  itemCount: 1,
  totalPages: 1,
};

describe('NotificationSearchPage filters', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedSearch.mockReset();
    mockedSearch.mockResolvedValue(emptyResponse());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders type, delivery status, and date filter controls', () => {
    render(<NotificationSearchPage />);

    expect(
      screen.getByLabelText(/filter by notification type/i),
    ).toBeInTheDocument();

    expect(
      screen.getByLabelText(/filter by delivery status/i),
    ).toBeInTheDocument();

    expect(
      screen.getByLabelText(/filter from date/i),
    ).toBeInTheDocument();

    expect(
      screen.getByLabelText(/filter to date/i),
    ).toBeInTheDocument();

    const typeSelect = screen.getByLabelText(
      /filter by notification type/i,
    );

    expect(typeSelect).toContainHTML('Discord');
    expect(typeSelect).toContainHTML('Email');
    expect(typeSelect).toContainHTML('Webhook');
    expect(typeSelect).toContainHTML('SMS');
  });

  it('calls searchNotifications with type, status, and date params', async () => {
    render(<NotificationSearchPage />);

    await act(async () => {
      fireEvent.change(
        screen.getByLabelText(
          /filter by notification type/i,
        ),
        {
          target: { value: 'discord' },
        },
      );

      fireEvent.change(
        screen.getByLabelText(
          /filter by delivery status/i,
        ),
        {
          target: { value: 'FAILED' },
        },
      );

      fireEvent.change(
        screen.getByLabelText(/filter from date/i),
        {
          target: { value: '2026-01-01' },
        },
      );

      fireEvent.change(
        screen.getByLabelText(/filter to date/i),
        {
          target: { value: '2026-01-31' },
        },
      );
    });

    await waitFor(() => {
      expect(mockedSearch).toHaveBeenCalled();
    });

    const lastCall =
      mockedSearch.mock.calls[
        mockedSearch.mock.calls.length - 1
      ];

    expect(lastCall?.[1]).toMatchObject({
      type: 'discord',
      status: 'FAILED',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
  });

  it('updates results when filters change', async () => {
    mockedSearch.mockResolvedValue({
      results: [
        {
          id: 1,
          source: 'scheduled',
          eventId: 'evt-1',
          txHash: null,
          contractAddress: null,
          notificationType: 'email',
          targetRecipient: 'alice',
          status: 'COMPLETED',
          createdAt: '2026-03-01T00:00:00.000Z',
          payload: null,
          failureReason: null,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
      itemCount: 1,
      totalPages: 1,
    });

    render(<NotificationSearchPage />);

    await act(async () => {
      fireEvent.change(
        screen.getByLabelText(
          /filter by notification type/i,
        ),
        {
          target: { value: 'email' },
        },
      );
    });

    expect(
      await screen.findByText('email'),
    ).toBeInTheDocument();

    expect(
      screen.getByText('COMPLETED'),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/1 result/i),
    ).toBeInTheDocument();
  });

  it('clears type, status, and date filters', async () => {
    render(<NotificationSearchPage />);

    await act(async () => {
      fireEvent.change(
        screen.getByLabelText(
          /filter by notification type/i,
        ),
        {
          target: { value: 'sms' },
        },
      );

      fireEvent.change(
        screen.getByLabelText(
          /filter by delivery status/i,
        ),
        {
          target: { value: 'PENDING' },
        },
      );

      fireEvent.change(
        screen.getByLabelText(/filter from date/i),
        {
          target: { value: '2026-02-01' },
        },
      );
    });

    expect(
      screen.getByRole('button', {
        name: /clear all filters/i,
      }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /clear all filters/i,
        }),
      );
    });

    expect(
      screen.getByLabelText(
        /filter by notification type/i,
      ),
    ).toHaveValue('');

    expect(
      screen.getByLabelText(
        /filter by delivery status/i,
      ),
    ).toHaveValue('');

    expect(
      screen.getByLabelText(/filter from date/i),
    ).toHaveValue('');

    expect(
      screen.queryByRole('button', {
        name: /clear all filters/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('shows a friendly timeout message when the listener search request expires', async () => {
    mockedSearch.mockRejectedValue(
      new Error(
        'Listener API request timed out after 10000ms.',
      ),
    );

    render(<NotificationSearchPage />);

    fireEvent.change(
      screen.getByLabelText(/free-text search/i),
      {
        target: { value: 'payment' },
      },
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          /The notification search timed out\. Please try again\./i,
        ),
      ).toBeInTheDocument();
    });
  });
});

describe('NotificationSearchPage loading skeletons', () => {
  beforeEach(() => {
    mockedSearch.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows result-card skeletons while searching and hides result text', async () => {
    mockedSearch.mockReturnValue(
      new Promise(() => {}),
    );

    render(<NotificationSearchPage />);

    fireEvent.change(
      screen.getByLabelText(/free-text search/i),
      {
        target: { value: 'payment' },
      },
    );

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(/searching notifications/i),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/searching…/i),
    ).not.toBeInTheDocument();

    expect(
      screen.getByLabelText(/searching notifications/i),
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('replaces skeletons with result cards once search completes', async () => {
    let resolveSearch!: (
      value: NotificationSearchResponse,
    ) => void;

    mockedSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );

    render(<NotificationSearchPage />);

    fireEvent.change(
      screen.getByLabelText(/free-text search/i),
      {
        target: { value: 'payment' },
      },
    );

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(/searching notifications/i),
      ).toBeInTheDocument();
    });

    await act(async () => {
      resolveSearch(mockResult);
    });

    await waitFor(() => {
      expect(
        screen.queryByLabelText(
          /searching notifications/i,
        ),
      ).not.toBeInTheDocument();
    });

    expect(
      screen.getByText(/1 result/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText('evt-abc'),
    ).toBeInTheDocument();

    expect(
      document.querySelector(
        '.notif-result-card__status',
      ),
    ).toHaveTextContent('PENDING');
  });
});

describe('NotificationResultCard copy notification ID', () => {
  beforeEach(() => {
    mockedSearch.mockReset();
    jest.useFakeTimers();

    Object.assign(navigator, {
      clipboard: {
        writeText: jest
          .fn()
          .mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the notification ID with a copy button in result cards', async () => {
    mockedSearch.mockResolvedValue(mockResult);

    render(<NotificationSearchPage />);

    fireEvent.change(
      screen.getByLabelText(/free-text search/i),
      {
        target: { value: 'test' },
      },
    );

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(
        screen.getByText('1'),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText('Notification ID'),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', {
        name: /copy notification id/i,
      }),
    ).toBeInTheDocument();
  });

  it('copies notification ID to clipboard when copy button is clicked', async () => {
    mockedSearch.mockResolvedValue(mockResult);

    render(<NotificationSearchPage />);

    fireEvent.change(
      screen.getByLabelText(/free-text search/i),
      {
        target: { value: 'test' },
      },
    );

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(
        screen.getByText('Notification ID'),
      ).toBeInTheDocument();
    });

    const copyBtn = screen.getByRole('button', {
      name: /copy notification id/i,
    });

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(
      navigator.clipboard.writeText,
    ).toHaveBeenCalledWith('1');
  });

  it('shows success feedback after copying notification ID', async () => {
    mockedSearch.mockResolvedValue(mockResult);

    render(<NotificationSearchPage />);

    fireEvent.change(
      screen.getByLabelText(/free-text search/i),
      {
        target: { value: 'test' },
      },
    );

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(
        screen.getByText('Notification ID'),
      ).toBeInTheDocument();
    });

    const copyBtn = screen.getByRole('button', {
      name: /copy notification id/i,
    });

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /notification id copied/i,
        }),
      ).toBeInTheDocument();
    });
  });
});