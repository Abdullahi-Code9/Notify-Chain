import { memo, useCallback } from 'react';

interface PaginationControlsProps {
  page: number;
  pageCount: number;
  limit: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  /** Override the page-size dropdown options. Defaults to [8, 12, 20, 40]. */
  pageSizeOptions?: number[];
  /** Override the label shown after the total count. Defaults to "events". */
  summaryLabel?: string;
}

const DEFAULT_LIMIT_OPTIONS = [8, 12, 20, 40];

export const PaginationControls = memo(function PaginationControls({
  page,
  pageCount,
  limit,
  totalCount,
  onPageChange,
  onLimitChange,
  pageSizeOptions = DEFAULT_LIMIT_OPTIONS,
  summaryLabel = 'events',
}: PaginationControlsProps) {
  const handlePrevious = useCallback(() => {
    onPageChange(Math.max(1, page - 1));
  }, [page, onPageChange]);

  const handleNext = useCallback(() => {
    onPageChange(Math.min(pageCount, page + 1));
  }, [page, pageCount, onPageChange]);

  const handleLimitChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    onLimitChange(Number(event.target.value));
  }, [onLimitChange]);

  const formattedTotal = totalCount.toLocaleString();

  return (
    <section className="pagination-controls" aria-label="Pagination controls">
      <div className="pagination-controls__summary">
        <span>
          Page {page} of {pageCount}
        </span>
        <span>{formattedTotal} total events</span>
      </div>

      <div className="pagination-controls__actions">
        <button
          type="button"
          className="pagination-controls__button"
          onClick={handlePrevious}
          disabled={page <= 1}
        >
          Previous
        </button>

        <label className="pagination-controls__label" htmlFor="items-per-page">
          Items per page
        </label>
        <select
          id="items-per-page"
          className="pagination-controls__select"
          value={limit}
          onChange={handleLimitChange}
        >
          {pageSizeOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="pagination-controls__button"
          onClick={handleNext}
          disabled={page >= pageCount}
        >
          Next
        </button>
      </div>
    </section>
  );
});
