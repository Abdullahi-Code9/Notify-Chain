import * as StellarSDK from '@stellar/stellar-sdk';
import { xdr } from '@stellar/stellar-sdk';

const defaultContract = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIU6KPNBAM';

export const EventFixtures = {
  valid: (
    overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {},
  ): StellarSDK.rpc.Api.EventResponse =>
    ({
      id: 'evt-valid-1',
      type: 'contract',
      ledger: 1000,
      ledgerClosedAt: '2026-06-22T00:00:00Z',
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      txHash: 'tx-valid-abc',
      topic: [xdr.scvSymbol('test_event')],
      value: xdr.scvString('valid payload'),
      contractId: { contractId: () => defaultContract } as any, // mock for contractId if needed
      ...overrides,
    }) as StellarSDK.rpc.Api.EventResponse,

  duplicate: (): StellarSDK.rpc.Api.EventResponse[] => {
    const base = EventFixtures.valid({ id: 'evt-dup-1', txHash: 'tx-dup-1' });
    return [base, { ...base }];
  },

  missingFields: (): Partial<StellarSDK.rpc.Api.EventResponse> => ({
    // Missing id, topic, value, etc.
    type: 'contract',
    ledger: 1001,
    inSuccessfulContractCall: true,
  }),

  unsupportedVersion: (): StellarSDK.rpc.Api.EventResponse =>
    EventFixtures.valid({
      id: 'evt-unsupported-1',
      value: xdr.scvMap([
        new xdr.ScMapEntry({
          key: xdr.scvSymbol('version'),
          val: xdr.scvU32(999), // Unsupported version
        }),
      ]),
    }),

  malformedPayload: (): StellarSDK.rpc.Api.EventResponse =>
    EventFixtures.valid({
      id: 'evt-malformed-1',
      // validateEventPayload explicitly rejects ledger < 0 as malformed
      ledger: -1,
    }),
};
