import { render, screen, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { EmptyState } from './EmptyState';

expect.extend(toHaveNoViolations);

test('EmptyState has no accessibility violations', async () => {
  const { container } = render(
    <EmptyState title="No results" message="Try adjusting your filters." />,
  );
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('renders the required message and optional title', () => {
  render(<EmptyState title="No events found" message="Update your filters to see results." />);
  expect(screen.getByText('No events found')).toBeInTheDocument();
  expect(screen.getByText('Update your filters to see results.')).toBeInTheDocument();
});

test('omits the title when none is provided', () => {
  render(<EmptyState message="Nothing here yet." />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
});

test('renders an action button and fires its callback on click', () => {
  const onClick = jest.fn();
  render(<EmptyState message="No templates yet." action={{ label: 'Create Template', onClick }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create Template' }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test('omits the action button when none is provided', () => {
  render(<EmptyState message="No templates yet." />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('applies the default size class unless overridden', () => {
  const { container, rerender } = render(<EmptyState message="No data" />);
  expect(container.firstChild).toHaveClass('empty-state--default');

  rerender(<EmptyState message="No data" size="compact" />);
  expect(container.firstChild).toHaveClass('empty-state--compact');

  rerender(<EmptyState message="No data" size="inline" />);
  expect(container.firstChild).toHaveClass('empty-state--inline');
});

test('renders a custom icon in place of the default one', () => {
  render(<EmptyState message="No data" icon={<span data-testid="custom-icon" />} />);
  expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
});

test('exposes a status role so screen readers announce the empty state', () => {
  render(<EmptyState message="No data available." />);
  expect(screen.getByRole('status')).toHaveTextContent('No data available.');
});
