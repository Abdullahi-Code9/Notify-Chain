import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  generateMockExports,
  type NotificationExport,
} from '../utils/exportData';
import { ExportHistoryTable } from '../components/ExportHistoryTable';
import { ExportHistorySkeleton } from '../components/ExportHistorySkeleton';
import { PaginationControls } from '../components/PaginationControls';
import { WalletConnectButton } from '../components/WalletConnectButton';
import { EmptyState } from '../components/EmptyState';

const PAGE_SIZE_OPTIONS = [5, 10, 25];
const DEFAULT_LIMIT = 5;
const SKELETON_DELAY_MS = 800;

function buildExportBlob(
  item: NotificationExport,
): { blob: Blob; filename: string } {
  const safeName = item.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');

  const filename = `${safeName}_${item.id}`;

  if (item.format === 'JSON') {
    const content = JSON.stringify(
      {
        export_id: item.id,
        export_name: item.name,
        format: item.format,
        created_at: new Date(item.createdAt).toISOString(),
        record_count: item.recordCount,
        records: Array.from({ length: 5 }, (_, i) => ({
          id: `notif-${2000 + i}`,
          contract:
            'CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5',
          event_name:
            i % 2 === 0
              ? 'NotificationScheduled'
              : 'NotificationExpired',
          timestamp: new Date(
            item.createdAt - i * 15 * 60 * 1000,
          ).toISOString(),
          status: 'Delivered',
        })),
      },
      null,
      2,
    );

    return {
      blob: new Blob([content], {
        type: 'application/json',
      }),
      filename: `${filename}.json`,
    };
  }

  if (item.format === 'CSV') {
    const rows = Array.from(
      { length: 5 },
      (_, i) =>
        `notif-${2000 + i},CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5,` +
        `${
          i % 2 === 0
            ? 'NotificationScheduled'
            : 'NotificationExpired'
        },` +
        `${new Date(
          item.createdAt - i * 15 * 60 * 1000,
        ).toISOString()},Delivered`,
    );

    const content =
      'ID,Contract Address,Event Name,Timestamp,Status\n' +
      rows.join('\n');

    return {
      blob: new Blob([content], {
        type: 'text/csv',
      }),
      filename: `${filename}.csv`,
    };
  }

  const createdFormatted = new Date(
    item.createdAt,
  ).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const content =
    `Notify-Chain Notification Export Report\n` +
    `========================================\n` +
    `Export ID:    ${item.id}\n` +
    `Export Name:  ${item.name}\n` +
    `Generated:    ${createdFormatted}\n` +
    `Records:      ${item.recordCount.toLocaleString()}\n` +
    `File Size:    ${item.fileSize}\n` +
    `========================================\n` +
    `* This is a mock PDF export representation *`;

  return {
    blob: new Blob([content], {
      type: 'text/plain',
    }),
    filename: `${filename}.txt`,
  };
}

function triggerDownload(
  blob: Blob,
  filename: string,
): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

export function ExportHistoryPage() {
  const [exports, setExports] = useState<
    NotificationExport[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] =
    useState<number>(DEFAULT_LIMIT);

  useEffect(() => {
    setIsLoading(true);

    const timer = setTimeout(() => {
      setExports(generateMockExports());
      setIsLoading(false);
    }, SKELETON_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  const filteredExports = useMemo(() => {
    const q = search.toLowerCase();

    return exports.filter((item) => {
      const matchesSearch =
        item.name.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.format.toLowerCase().includes(q);

      const matchesStatus =
        statusFilter === 'all' ||
        item.status.toLowerCase() ===
          statusFilter.toLowerCase();

      return matchesSearch && matchesStatus;
    });
  }, [exports, search, statusFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const totalCount = filteredExports.length;

  const pageCount = Math.max(
    1,
    Math.ceil(totalCount / limit),
  );

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [pageCount, page]);

  const displayedExports = useMemo(() => {
    const start = (page - 1) * limit;

    return filteredExports.slice(
      start,
      start + limit,
    );
  }, [filteredExports, page, limit]);

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      setLimit(newLimit);
      setPage(1);
    },
    [],
  );

  const handleDownload = useCallback(
    (item: NotificationExport) => {
      if (item.status !== 'Completed') {
        return;
      }

      const { blob, filename } =
        buildExportBlob(item);

      triggerDownload(blob, filename);
    },
    [],
  );

  const hasActiveFilters =
    search || statusFilter !== 'all';

  return (
    <main className="export-history-page">
      <header className="export-history__header">
        <div>
          <p className="export-history__eyebrow">
            Export Center
          </p>

          <h1>Notification Export History</h1>

          <p className="export-history__lead">
            Manage, filter, and download your previously
            generated notification and smart contract
            event export records.
          </p>
        </div>

        <WalletConnectButton />
      </header>

      <section
        className="export-filters"
        aria-label="Export history filters"
      >
        <div className="event-filters__group">
          <label htmlFor="export-search">
            Search Exports
          </label>

          <input
            id="export-search"
            type="text"
            placeholder="Search by name, ID or format…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="event-filters__group">
          <label htmlFor="export-status-filter">
            Status
          </label>

          <select
            id="export-status-filter"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value)
            }
          >
            <option value="all">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="processing">
              Processing
            </option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <p
          className="event-filters__count"
          aria-live="polite"
          aria-atomic="true"
        >
          {isLoading
            ? '—'
            : `${totalCount.toLocaleString()} ${
                totalCount === 1
                  ? 'record'
                  : 'records'
              }`}
        </p>
      </section>

      {isLoading && (
        <ExportHistorySkeleton rows={5} />
      )}

      {!isLoading && displayedExports.length > 0 && (
        <ExportHistoryTable
          exports={displayedExports}
          onDownload={handleDownload}
        />
      )}

      {!isLoading && displayedExports.length === 0 && (
        <EmptyState
          title="No export records found"
          description={
            hasActiveFilters
              ? 'Try modifying your search query or status filter to locate matching exports.'
              : 'You have no export records yet.'
          }
          action={
            hasActiveFilters
              ? {
                  label: 'Clear filters',
                  onClick: () => {
                    setSearch('');
                    setStatusFilter('all');
                  },
                }
              : undefined
          }
        />
      )}

      {!isLoading && (
        <PaginationControls
          page={page}
          pageCount={pageCount}
          limit={limit}
          totalCount={totalCount}
          onPageChange={setPage}
          onLimitChange={handleLimitChange}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          summaryLabel="export records"
        />
      )}
    </main>
  );
}