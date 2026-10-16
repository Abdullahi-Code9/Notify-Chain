import { render, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { PaginationControls } from './PaginationControls';

expect.extend(toHaveNoViolations);

describe('PaginationControls', () => {
  const defaultProps = {
    page: 2,
    pageCount: 5,
    limit: 12,
    totalCount: 50,
    onPageChange: jest.fn(),
    onLimitChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders page summary and total count', () => {
    const { getByText } = render(<PaginationControls {...defaultProps} />);

    expect(getByText('Page 2 of 5')).toBeInTheDocument();
    expect(getByText('50 total events')).toBeInTheDocument();
  });

  it('uses custom summary label when provided', () => {
    const { getByText } = render(
      <PaginationControls {...defaultProps} summaryLabel="notifications" />,
    );

    expect(getByText('50 total notifications')).toBeInTheDocument();
  });

  it('navigates to previous and next pages', () => {
    const onPageChange = jest.fn();
    const { getByRole } = render(
      <PaginationControls {...defaultProps} onPageChange={onPageChange} />,
    );

    fireEvent.click(getByRole('button', { name: /previous/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    fireEvent.click(getByRole('button', { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('disables Previous on first page and Next on last page', () => {
    const { getByRole, rerender } = render(<PaginationControls {...defaultProps} page={1} />);
    expect(getByRole('button', { name: /previous/i })).toBeDisabled();

    rerender(<PaginationControls {...defaultProps} page={5} pageCount={5} />);
    expect(getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('changes items per page', () => {
    const onLimitChange = jest.fn();
    const { getByLabelText } = render(
      <PaginationControls {...defaultProps} onLimitChange={onLimitChange} />,
    );

    fireEvent.change(getByLabelText(/items per page/i), { target: { value: '20' } });
    expect(onLimitChange).toHaveBeenCalledWith(20);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<PaginationControls {...defaultProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
