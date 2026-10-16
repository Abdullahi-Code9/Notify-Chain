import '@testing-library/jest-dom';
import { render, fireEvent, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { ExportHistoryPage } from './ExportHistoryPage';

expect.extend(toHaveNoViolations);

test('ExportHistoryPage has no accessibility violations', async () => {
  jest.useFakeTimers();

  try {
    const { container } = render(<ExportHistoryPage />);

    await act(async () => {
      jest.advanceTimersByTime(900);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  } finally {
    jest.useRealTimers();
  }
});

describe('ExportHistoryPage interactions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function renderLoadedPage() {
    const view = render(<ExportHistoryPage />);

    act(() => {
      jest.advanceTimersByTime(900);
    });

    return view;
  }

  test('renders correctly and lists mock exports', () => {
    const { getByText, getByRole, getAllByRole } =
      renderLoadedPage();

    expect(
      getByText('Notification Export History'),
    ).toBeInTheDocument();

    expect(
      getByText(/Manage, filter, and download/),
    ).toBeInTheDocument();

    expect(getByRole('table')).toBeInTheDocument();

    const rows = getAllByRole('row');
    expect(rows).toHaveLength(6);
  });

  test('search and filtering works', () => {
    const {
      getByLabelText,
      queryByText,
      getByText,
    } = renderLoadedPage();

    const searchInput =
      getByLabelText('Search Exports');

    fireEvent.change(searchInput, {
      target: { value: 'System Alert' },
    });

    expect(
      getByText('System Alert Notification logs'),
    ).toBeInTheDocument();

    expect(
      queryByText('Monthly billing export'),
    ).not.toBeInTheDocument();
  });

  test('pagination limit and page switching works', () => {
    const {
      getByLabelText,
      getByText,
      queryByText,
    } = renderLoadedPage();

    expect(
      getByText('Page 1 of 3'),
    ).toBeInTheDocument();

    expect(
      getByText('15 total export records'),
    ).toBeInTheDocument();

    expect(
      getByText('System Alert Notification logs'),
    ).toBeInTheDocument();

    fireEvent.click(getByText('Next'));

    expect(
      getByText('Page 2 of 3'),
    ).toBeInTheDocument();

    expect(
      queryByText('System Alert Notification logs'),
    ).not.toBeInTheDocument();

    fireEvent.change(
      getByLabelText('Items per page'),
      {
        target: { value: '10' },
      },
    );

    expect(
      getByText('Page 1 of 2'),
    ).toBeInTheDocument();
  });
});