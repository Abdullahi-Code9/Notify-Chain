import { fireEvent, render, screen } from '@testing-library/react';
import { DashboardViewPreferences } from './DashboardViewPreferences';
import {
  DEFAULT_DASHBOARD_PREFERENCES,
  type DashboardPreferences,
} from '../utils/dashboardPreferences';

describe('DashboardViewPreferences', () => {
  it('updates density and columns and prevents hiding every column', () => {
    const onChange = jest.fn();
    const preferences: DashboardPreferences = {
      ...DEFAULT_DASHBOARD_PREFERENCES,
      visibleColumns: ['event'],
    };

    render(
      <DashboardViewPreferences
        preferences={preferences}
        onChange={onChange}
        onReset={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Table density'), {
      target: { value: 'compact' },
    });
    expect(onChange).toHaveBeenCalledWith({ ...preferences, density: 'compact' });

    expect(screen.getByRole('checkbox', { name: 'Event' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contract' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...preferences,
      visibleColumns: ['event', 'contract'],
    });
  });

  it('provides a reset action', () => {
    const onReset = jest.fn();
    render(
      <DashboardViewPreferences
        preferences={DEFAULT_DASHBOARD_PREFERENCES}
        onChange={jest.fn()}
        onReset={onReset}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset dashboard view' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
