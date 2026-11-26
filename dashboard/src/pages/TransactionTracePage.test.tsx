import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TransactionTracePage } from './TransactionTracePage';

jest.mock('../services/transactionTraceApi', () => ({
  fetchTransactionTrace: jest.fn(),
}));

import { fetchTransactionTrace } from '../services/transactionTraceApi';

const mockedFetchTransactionTrace = jest.mocked(fetchTransactionTrace);
const HASH = 'b'.repeat(64);

describe('TransactionTracePage', () => {
  beforeEach(() => mockedFetchTransactionTrace.mockReset());

  it('validates hashes before querying and shows a missing-details error', async () => {
    render(<TransactionTracePage />);
    fireEvent.change(screen.getByLabelText('Transaction hash'), {
      target: { value: 'short' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect transaction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'valid 64-character Stellar transaction hash',
    );
    expect(mockedFetchTransactionTrace).not.toHaveBeenCalled();
  });

  it('renders transaction metadata and expanded operation details', async () => {
    mockedFetchTransactionTrace.mockResolvedValue({
      hash: HASH,
      ledger: 123,
      source_account: 'GABC',
      created_at: '2026-01-01T00:00:00Z',
      successful: true,
      operations: [{ id: '1', type: 'payment', source_account: 'GABC', amount: '2.5' }],
    });

    render(<TransactionTracePage />);
    fireEvent.change(screen.getByLabelText('Transaction hash'), {
      target: { value: HASH },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect transaction' }));

    expect(await screen.findByText('payment')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Operation details'));
    expect(screen.getByText(/"amount": "2.5"/)).toBeInTheDocument();
  });

  it('highlights failed transactions and displays the failure result', async () => {
    mockedFetchTransactionTrace.mockResolvedValue({
      hash: HASH,
      ledger: 123,
      source_account: 'GABC',
      created_at: '2026-01-01T00:00:00Z',
      successful: false,
      result_xdr: 'failed-xdr',
      operations: [],
    });

    render(<TransactionTracePage />);
    fireEvent.change(screen.getByLabelText('Transaction hash'), {
      target: { value: HASH },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect transaction' }));

    await waitFor(() => expect(screen.getByText('Transaction failed')).toBeInTheDocument());
    fireEvent.click(screen.getByText('View failure result'));
    expect(screen.getByText('failed-xdr')).toBeInTheDocument();
  });
});
