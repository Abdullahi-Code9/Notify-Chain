import { act, fireEvent, render, screen } from '@testing-library/react';
import { TimezoneSelector } from './TimezoneSelector';
import { EventCard } from './EventCard';
import { useTimezoneStore } from '../store/timezoneStore';
import type { BlockchainEvent } from '../types/event';
import { generateMockEvents } from '../utils/eventData';

describe('TimezoneSelector (#1108)', () => {
  afterEach(() => {
    act(() => useTimezoneStore.getState().setPreference('local'));
    localStorage.clear();
  });

  it('offers local time and UTC', () => {
    render(<TimezoneSelector />);
    const select = screen.getByLabelText('Timezone') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['local', 'UTC']));
    expect(select.value).toBe('local');
  });

  it('updates the store when a timezone is selected', () => {
    render(<TimezoneSelector />);
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'UTC' } });
    expect(useTimezoneStore.getState().preference).toBe('UTC');
  });

  it('re-renders event timestamps and keeps the UTC metadata', () => {
    const [base] = generateMockEvents(1);
    const event: BlockchainEvent = { ...base, receivedAt: 1705329045000 };

    render(
      <>
        <TimezoneSelector />
        <EventCard event={event} variant="expanded" />
      </>,
    );

    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'UTC' } });

    expect(screen.getByText('Received (UTC)')).toBeInTheDocument();
    expect(screen.getByText('2024-01-15T14:30:45.000Z')).toBeInTheDocument();
    expect(screen.getAllByText(/UTC/).length).toBeGreaterThan(0);
  });
});
