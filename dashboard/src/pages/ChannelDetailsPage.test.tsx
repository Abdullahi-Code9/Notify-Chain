import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ChannelDetailsPage } from './ChannelDetailsPage';

describe('ChannelDetailsPage Keyword Search', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const renderAndLoad = async () => {
    const result = render(<ChannelDetailsPage />);
    // Fast-forward past the simulated 600ms API fetch inside act
    act(() => {
      jest.advanceTimersByTime(700);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/loading channel/i)).not.toBeInTheDocument();
    });
    return result;
  };

  it('renders page header, summary strip, and all channels by default', async () => {
    await renderAndLoad();

    expect(screen.getByRole('heading', { level: 1, name: /channel details/i })).toBeInTheDocument();
    expect(screen.getByText(/4 channels available/i)).toBeInTheDocument();

    expect(screen.getByRole('article', { name: /in-app channel details/i })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /email channel details/i })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /discord channel details/i })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /telegram channel details/i })).toBeInTheDocument();
  });

  it('filters channels by name keyword', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i);
    fireEvent.change(searchInput, { target: { value: 'Discord' } });

    expect(screen.getByText(/showing 1 of 4 channels/i)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /discord channel details/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /in-app channel details/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /email channel details/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /telegram channel details/i }),
    ).not.toBeInTheDocument();
  });

  it('filters channels by protocol keyword (case-insensitive)', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i);
    fireEvent.change(searchInput, { target: { value: 'smtp' } });

    expect(screen.getByText(/showing 1 of 4 channels/i)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /email channel details/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /discord channel details/i }),
    ).not.toBeInTheDocument();
  });

  it('filters channels by description keyword', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i);
    fireEvent.change(searchInput, { target: { value: 'real time' } });

    expect(screen.getByRole('article', { name: /in-app channel details/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /email channel details/i }),
    ).not.toBeInTheDocument();
  });

  it('filters channels by status keyword', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i);
    fireEvent.change(searchInput, { target: { value: 'degraded' } });

    expect(screen.getByRole('article', { name: /telegram channel details/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /in-app channel details/i }),
    ).not.toBeInTheDocument();
  });

  it('filters channels with multiple keywords', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i);
    fireEvent.change(searchInput, { target: { value: 'active discord' } });

    expect(screen.getByRole('article', { name: /discord channel details/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /telegram channel details/i }),
    ).not.toBeInTheDocument();
  });

  it('displays empty state when no channels match keyword search', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i);
    fireEvent.change(searchInput, { target: { value: 'nonexistent-channel' } });

    expect(
      screen.getByRole('heading', { level: 2, name: /no channels found/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /no channels match "nonexistent-channel"\. try searching with different keywords\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('clears search when clicking the empty state action button', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'random-query' } });

    expect(
      screen.getByRole('heading', { level: 2, name: /no channels found/i }),
    ).toBeInTheDocument();

    const clearButton = screen.getByRole('button', { name: /clear search/i });
    fireEvent.click(clearButton);

    expect(searchInput.value).toBe('');
    expect(screen.getAllByRole('article')).toHaveLength(4);
  });

  it('clears search when clicking the clear icon button (✕)', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'discord' } });

    const clearIconButton = screen.getByRole('button', { name: /clear channel search/i });
    fireEvent.click(clearIconButton);

    expect(searchInput.value).toBe('');
    expect(screen.getAllByRole('article')).toHaveLength(4);
  });

  it('clears search when pressing Escape key in search input', async () => {
    await renderAndLoad();

    const searchInput = screen.getByLabelText(/search channels by keywords/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'telegram' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);

    fireEvent.keyDown(searchInput, { key: 'Escape' });

    expect(searchInput.value).toBe('');
    expect(screen.getAllByRole('article')).toHaveLength(4);
  });
});
