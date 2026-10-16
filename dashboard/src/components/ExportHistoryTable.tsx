import { memo } from 'react';
import type { NotificationExport } from '../utils/exportData';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface ExportHistoryTableProps {
  exports: NotificationExport[];
  onDownload: (item: NotificationExport) => void;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function FormatBadge({ format }: { format: NotificationExport['format'] }) {
  return <span className={`format-badge format-badge--${format.toLowerCase()}`}>{format}</span>;
}

function StatusBadge({ status }: { status: NotificationExport['status'] }) {
  const label =
    status === 'Processing' ? (
      <>
        <span className="status-badge__dot" aria-hidden="true" />
        Processing
        <span className="sr-only">(in progress)</span>
      </>
    ) : (
      <>
        <span className="status-badge__dot" aria-hidden="true" />
        {status}
      </>
    );

  return <span className={`status-badge status-badge--${status.toLowerCase()}`}>{label}</span>;
}

function DownloadButton({
  item,
  onDownload,
}: {
  item: NotificationExport;
  onDownload: (item: NotificationExport) => void;
}) {
  const isCompleted = item.status === 'Completed';
  const isProcessing = item.status === 'Processing';

  const label = isCompleted
    ? `Download ${item.name}`
    : isProcessing
      ? `${item.name} is still generating`
      : `${item.name} export failed — download unavailable`;

  return (
    <button
      type="button"
      className="export-action-btn"
      onClick={() => onDownload(item)}
      disabled={!isCompleted}
      aria-label={label}
    >
      {isCompleted ? (
        <>
          <svg
            className="download-icon"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Download
        </>
      ) : isProcessing ? (
        'Generating…'
      ) : (
        'Unavailable'
      )}
    </button>
  );
}

function ExportRow({
  item,
  onDownload,
}: {
  item: NotificationExport;
  onDownload: (item: NotificationExport) => void;
}) {
  return (
    <tr className="export-table__row">
      <td className="export-table__cell-id" data-label="ID">
        {item.id}
      </td>
      <td className="export-table__cell-name" data-label="Name">
        {item.name}
      </td>
      <td data-label="Format">
        <FormatBadge format={item.format} />
      </td>
      <td className="export-table__cell-date" data-label="Created At">
        {formatDate(item.createdAt)}
      </td>
      <td className="export-table__cell-numeric" data-label="Records">
        {item.recordCount.toLocaleString()}
      </td>
      <td className="export-table__cell-numeric" data-label="Size">
        {item.fileSize}
      </td>
      <td data-label="Status">
        <StatusBadge status={item.status} />
      </td>
      <td className="export-table__cell-action" data-label="Actions">
        <DownloadButton item={item} onDownload={onDownload} />
      </td>
    </tr>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────

export const ExportHistoryTable = memo(function ExportHistoryTable({
  exports,
  onDownload,
}: ExportHistoryTableProps) {
  return (
    <div className="export-table-container" role="region" aria-label="Export history">
      <table className="export-table">
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Name</th>
            <th scope="col">Format</th>
            <th scope="col">Created At</th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Records
            </th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Size
            </th>
            <th scope="col">Status</th>
            <th scope="col" style={{ textAlign: 'center' }}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {exports.map((item) => (
            <ExportRow key={item.id} item={item} onDownload={onDownload} />
          ))}
        </tbody>
      </table>
    </div>
  );
});
