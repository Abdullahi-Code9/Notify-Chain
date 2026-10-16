import { useState, useCallback } from 'react';
import { useRpcBenchmarkStore } from '../store/rpcBenchmarkStore';
import type { BenchmarkResult } from '../services/rpcBenchmarkService';
import type { RpcEndpoint } from '../config/rpcEndpoints';

// ── Helpers ──────────────────────────────────────────────────────────────────

function latencyColor(ms: number | null): string {
  if (ms === null) return '#9aa0a6';
  if (ms < 300) return '#34d399';
  if (ms < 800) return '#f4b400';
  return '#f87171';
}

function statusBadgeClass(status: BenchmarkResult['status']): string {
  return `rpc-bench__status rpc-bench__status--${status}`;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function SummaryStrip({
  results,
  activeRpcUrl,
}: {
  results: BenchmarkResult[];
  activeRpcUrl: string;
}) {
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status !== 'ok').length;
  const fastest = results.find((r) => r.status === 'ok');
  const maxBlock = results
    .filter((r) => r.blockHeight !== null)
    .reduce((m, r) => Math.max(m, r.blockHeight!), 0);

  return (
    <div className="rpc-bench__summary" role="region" aria-label="Benchmark summary">
      <div className="rpc-bench__summary-item">
        <span className="rpc-bench__summary-value">{results.length}</span>
        <span className="rpc-bench__summary-label">Tested</span>
      </div>
      <div className="rpc-bench__summary-item">
        <span className="rpc-bench__summary-value rpc-bench__summary-value--ok">
          {ok}
        </span>
        <span className="rpc-bench__summary-label">Available</span>
      </div>
      <div className="rpc-bench__summary-item">
        <span className="rpc-bench__summary-value rpc-bench__summary-value--fail">
          {failed}
        </span>
        <span className="rpc-bench__summary-label">Failed</span>
      </div>
      <div className="rpc-bench__summary-item">
        <span className="rpc-bench__summary-value">
          {fastest ? `${fastest.latencyMs}ms` : '—'}
        </span>
        <span className="rpc-bench__summary-label">Fastest Latency</span>
      </div>
      <div className="rpc-bench__summary-item">
        <span className="rpc-bench__summary-value">
          {maxBlock > 0 ? maxBlock.toLocaleString() : '—'}
        </span>
        <span className="rpc-bench__summary-label">Highest Block</span>
      </div>
      <div className="rpc-bench__summary-item">
        <span
          className="rpc-bench__summary-value"
          title={activeRpcUrl}
        >
          {activeRpcUrl.length > 30
            ? activeRpcUrl.slice(0, 30) + '...'
            : activeRpcUrl}
        </span>
        <span className="rpc-bench__summary-label">Active Endpoint</span>
      </div>
    </div>
  );
}

function ResultRow({ result, maxBlock }: { result: BenchmarkResult; maxBlock: number }) {
  const blockDiff =
    result.blockHeight !== null && maxBlock > 0
      ? maxBlock - result.blockHeight
      : null;

  return (
    <tr
      className={`rpc-bench__row rpc-bench__row--${result.status}`}
      aria-label={`${result.label}: ${result.status}`}
    >
      <td className="rpc-bench__cell rpc-bench__cell--rank">
        {result.status === 'ok' && result.rank !== Infinity ? (
          <span className="rpc-bench__rank">#{result.rank}</span>
        ) : (
          <span className="rpc-bench__rank rpc-bench__rank--na">—</span>
        )}
      </td>
      <td className="rpc-bench__cell rpc-bench__cell--name">
        <span className="rpc-bench__endpoint-label">{result.label}</span>
        <span className="rpc-bench__endpoint-url">{result.url}</span>
      </td>
      <td className="rpc-bench__cell rpc-bench__cell--latency">
        {result.latencyMs !== null ? (
          <span style={{ color: latencyColor(result.latencyMs), fontWeight: 600 }}>
            {result.latencyMs} ms
          </span>
        ) : (
          <span className="rpc-bench__na">—</span>
        )}
      </td>
      <td className="rpc-bench__cell rpc-bench__cell--block">
        {result.blockHeight !== null ? (
          result.blockHeight.toLocaleString()
        ) : (
          <span className="rpc-bench__na">—</span>
        )}
      </td>
      <td className="rpc-bench__cell rpc-bench__cell--sync">
        {blockDiff !== null ? (
          <span
            className={
              blockDiff === 0
                ? 'rpc-bench__sync rpc-bench__sync--synced'
                : 'rpc-bench__sync rpc-bench__sync--behind'
            }
          >
            {blockDiff === 0 ? 'Synced' : `−${blockDiff}`}
          </span>
        ) : (
          <span className="rpc-bench__na">—</span>
        )}
      </td>
      <td className="rpc-bench__cell rpc-bench__cell--status">
        <span className={statusBadgeClass(result.status)}>
          {result.status === 'ok'
            ? 'Available'
            : result.status === 'timeout'
              ? 'Timeout'
              : 'Error'}
        </span>
        {result.errorMessage && (
          <span className="rpc-bench__error-msg" title={result.errorMessage}>
            {result.errorMessage.length > 40
              ? result.errorMessage.slice(0, 40) + '...'
              : result.errorMessage}
          </span>
        )}
      </td>
    </tr>
  );
}

function ResultTable({ results }: { results: BenchmarkResult[] }) {
  const maxBlock = results
    .filter((r) => r.blockHeight !== null)
    .reduce((m, r) => Math.max(m, r.blockHeight!), 0);

  return (
    <div className="rpc-bench__table-wrap">
      <table className="rpc-bench__table" role="grid" aria-label="Benchmark results">
        <thead>
          <tr>
            <th className="rpc-bench__th" scope="col">Rank</th>
            <th className="rpc-bench__th" scope="col">Endpoint</th>
            <th className="rpc-bench__th" scope="col">Latency</th>
            <th className="rpc-bench__th" scope="col">Block Height</th>
            <th className="rpc-bench__th" scope="col">Sync</th>
            <th className="rpc-bench__th" scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <ResultRow key={r.endpointId} result={r} maxBlock={maxBlock} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddEndpointForm({
  onAdd,
}: {
  onAdd: (ep: RpcEndpoint) => void;
}) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError('');

      const trimmedLabel = label.trim();
      const trimmedUrl = url.trim();

      if (!trimmedLabel || !trimmedUrl) {
        setError('Both label and URL are required.');
        return;
      }

      try {
        new URL(trimmedUrl);
      } catch {
        setError('Invalid URL format.');
        return;
      }

      const id = `custom-${Date.now()}`;
      onAdd({
        id,
        url: trimmedUrl,
        label: trimmedLabel,
        network: 'custom',
      });

      setLabel('');
      setUrl('');
    },
    [label, url, onAdd],
  );

  return (
    <form className="rpc-bench__add-form" onSubmit={handleSubmit}>
      <div className="rpc-bench__form-row">
        <label className="rpc-bench__form-label" htmlFor="rpc-label">
          Label
        </label>
        <input
          id="rpc-label"
          type="text"
          className="rpc-bench__form-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="My Private Node"
        />
      </div>
      <div className="rpc-bench__form-row">
        <label className="rpc-bench__form-label" htmlFor="rpc-url">
          RPC URL
        </label>
        <input
          id="rpc-url"
          type="text"
          className="rpc-bench__form-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://my-rpc.example.com:8000"
        />
      </div>
      {error && (
        <p className="rpc-bench__form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="rpc-bench__btn rpc-bench__btn--add">
        Add Endpoint
      </button>
    </form>
  );
}

function SkeletonTable() {
  return (
    <div className="rpc-bench__table-wrap" aria-busy="true" aria-label="Loading benchmark results">
      <table className="rpc-bench__table">
        <thead>
          <tr>
            <th className="rpc-bench__th">Rank</th>
            <th className="rpc-bench__th">Endpoint</th>
            <th className="rpc-bench__th">Latency</th>
            <th className="rpc-bench__th">Block Height</th>
            <th className="rpc-bench__th">Sync</th>
            <th className="rpc-bench__th">Status</th>
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4].map((i) => (
            <tr key={i} className="rpc-bench__row rpc-bench__row--skeleton">
              <td className="rpc-bench__cell">
                <div className="rpc-bench__skeleton-line rpc-bench__skeleton-line--sm" />
              </td>
              <td className="rpc-bench__cell">
                <div className="rpc-bench__skeleton-line rpc-bench__skeleton-line--md" />
              </td>
              <td className="rpc-bench__cell">
                <div className="rpc-bench__skeleton-line rpc-bench__skeleton-line--sm" />
              </td>
              <td className="rpc-bench__cell">
                <div className="rpc-bench__skeleton-line rpc-bench__skeleton-line--sm" />
              </td>
              <td className="rpc-bench__cell">
                <div className="rpc-bench__skeleton-line rpc-bench__skeleton-line--sm" />
              </td>
              <td className="rpc-bench__cell">
                <div className="rpc-bench__skeleton-line rpc-bench__skeleton-line--sm" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function RpcBenchmarkPage() {
  const {
    endpoints,
    results,
    isRunning,
    activeRpcUrl,
    error,
    addEndpoint,
    removeEndpoint,
    runTests,
    connectToFastest,
  } = useRpcBenchmarkStore();

  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);

  const handleConnect = useCallback(() => {
    const url = connectToFastest();
    if (url) {
      setConnectedUrl(url);
    }
  }, [connectToFastest]);

  const handleRemove = useCallback(
    (id: string) => {
      removeEndpoint(id);
    },
    [removeEndpoint],
  );

  return (
    <main className="rpc-bench">
      {/* Page header */}
      <header className="rpc-bench__header">
        <div>
          <p className="rpc-bench__eyebrow">Diagnostics</p>
          <h1 className="rpc-bench__title">RPC Endpoint Benchmark</h1>
          <p className="rpc-bench__lead">
            Test multiple Soroban RPC endpoints in parallel to find the fastest
            available node for your network.
          </p>
        </div>
        <div className="rpc-bench__header-actions">
          <button
            type="button"
            className="rpc-bench__btn rpc-bench__btn--primary"
            onClick={runTests}
            disabled={isRunning || endpoints.length === 0}
          >
            {isRunning ? 'Running...' : 'Run Benchmark'}
          </button>
          {results.length > 0 &&
            results.some((r) => r.status === 'ok') && (
              <button
                type="button"
                className="rpc-bench__btn rpc-bench__btn--connect"
                onClick={handleConnect}
              >
                Connect to Fastest Endpoint
              </button>
            )}
        </div>
      </header>

      {/* Connected confirmation */}
      {connectedUrl && (
        <div className="rpc-bench__connected" role="status">
          <strong>Connected!</strong> Active RPC set to{' '}
          <code>{connectedUrl}</code>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="rpc-bench__error-banner" role="alert">
          <strong>Error:</strong> {error}
          <button
            type="button"
            onClick={runTests}
            className="rpc-bench__error-banner__retry"
          >
            Retry
          </button>
        </div>
      )}

      {/* Summary strip */}
      {results.length > 0 && !isRunning && (
        <SummaryStrip results={results} activeRpcUrl={activeRpcUrl} />
      )}

      {/* Endpoint list with remove buttons */}
      <section className="rpc-bench__endpoints" aria-label="Configured endpoints">
        <h2 className="rpc-bench__section-title">Endpoints ({endpoints.length})</h2>
        <div className="rpc-bench__endpoint-list">
          {endpoints.map((ep) => (
            <div key={ep.id} className="rpc-bench__endpoint-chip">
              <span className="rpc-bench__endpoint-chip-label">{ep.label}</span>
              <span className="rpc-bench__endpoint-chip-url">{ep.url}</span>
              <span className={`rpc-bench__endpoint-chip-network rpc-bench__endpoint-chip-network--${ep.network}`}>
                {ep.network}
              </span>
              {ep.url === activeRpcUrl && (
                <span className="rpc-bench__endpoint-chip-active">Active</span>
              )}
              <button
                type="button"
                className="rpc-bench__endpoint-chip-remove"
                aria-label={`Remove ${ep.label}`}
                onClick={() => handleRemove(ep.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Add custom endpoint */}
      <section className="rpc-bench__add-section" aria-label="Add custom endpoint">
        <h2 className="rpc-bench__section-title">Add Custom Endpoint</h2>
        <AddEndpointForm onAdd={addEndpoint} />
      </section>

      {/* Results */}
      <section className="rpc-bench__results" aria-label="Benchmark results">
        <h2 className="rpc-bench__section-title">Results</h2>
        {isRunning ? (
          <SkeletonTable />
        ) : results.length > 0 ? (
          <ResultTable results={results} />
        ) : (
          <p className="rpc-bench__empty">
            No results yet. Click <strong>Run Benchmark</strong> to test your
            configured endpoints.
          </p>
        )}
      </section>
    </main>
  );
}
