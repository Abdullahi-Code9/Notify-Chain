import { useState, type FormEvent } from 'react';
import { getStellarNetworkName } from '../config/stellarNetwork';
import { fetchTransactionTrace, type TransactionTrace } from '../services/transactionTraceApi';

export function TransactionTracePage() {
  const [hash, setHash] = useState('');
  const [transaction, setTransaction] = useState<TransactionTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedHash = hash.trim();

    if (!/^[\da-f]{64}$/i.test(submittedHash)) {
      setTransaction(null);
      setError('Enter a valid 64-character Stellar transaction hash.');
      return;
    }

    setLoading(true);
    setTransaction(null);
    setError(null);
    try {
      setTransaction(await fetchTransactionTrace(submittedHash));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to load transaction details.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="transaction-trace" aria-labelledby="transaction-trace-title">
      <header className="transaction-trace__header">
        <p className="event-explorer__eyebrow">Transaction Trace</p>
        <h1 id="transaction-trace-title">Transaction Execution Trace</h1>
        <p>
          Inspect the ordered operations, source account, and ledger details for a Stellar
          transaction.
        </p>
      </header>

      <form className="transaction-trace__search" onSubmit={handleSubmit}>
        <label htmlFor="transaction-trace-hash">Transaction hash</label>
        <div className="transaction-trace__search-row">
          <input
            id="transaction-trace-hash"
            value={hash}
            onChange={(event) => setHash(event.target.value)}
            placeholder="64-character transaction hash"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Loading…' : 'Inspect transaction'}
          </button>
        </div>
        <span className="transaction-trace__network">Network: {getStellarNetworkName()}</span>
      </form>

      {error && (
        <p className="transaction-trace__error" role="alert">
          {error}
        </p>
      )}

      {transaction && (
        <section
          className={`transaction-trace__result${transaction.successful ? '' : ' transaction-trace__result--failed'}`}
          aria-label="Transaction details"
        >
          <div className="transaction-trace__summary">
            <div>
              <span className="transaction-trace__label">Transaction hash</span>
              <code>{transaction.hash}</code>
            </div>
            <div>
              <span className="transaction-trace__label">Source account</span>
              <code>{transaction.source_account}</code>
            </div>
            <div>
              <span className="transaction-trace__label">Ledger</span>
              <span>{transaction.ledger.toLocaleString()}</span>
            </div>
            <div>
              <span className="transaction-trace__label">Operations</span>
              <span>{transaction.operations.length}</span>
            </div>
            <div>
              <span className="transaction-trace__label">Created</span>
              <time dateTime={transaction.created_at}>
                {new Date(transaction.created_at).toLocaleString()}
              </time>
            </div>
          </div>

          {!transaction.successful && (
            <div className="transaction-trace__failure" role="alert">
              <strong>Transaction failed</strong>
              {transaction.result_xdr ? (
                <details>
                  <summary>View failure result</summary>
                  <pre>{transaction.result_xdr}</pre>
                </details>
              ) : (
                <p>No failure details were provided by the network.</p>
              )}
            </div>
          )}

          <h2>Operations in execution order</h2>
          {transaction.operations.length ? (
            <ol className="transaction-trace__operations" aria-label="Transaction operations">
              {transaction.operations.map((operation, index) => (
                <li
                  key={operation.id ?? `${operation.type ?? 'operation'}-${index}`}
                  className="transaction-trace__operation"
                >
                  <div className="transaction-trace__operation-heading">
                    <span className="transaction-trace__operation-index">{index + 1}</span>
                    <strong>{operation.type ?? 'Unknown operation'}</strong>
                  </div>
                  <p>
                    Source account: <code>{operation.source_account ?? 'Not provided'}</code>
                  </p>
                  <details>
                    <summary>Operation details</summary>
                    <pre>{JSON.stringify(operation, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="transaction-trace__empty">
              No operations were returned for this transaction.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
