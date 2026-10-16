import { describe, expect, it, jest } from '@jest/globals';
import { Database } from '../database/database';
import { DeliveryReceiptRepository } from './delivery-receipt-repository';

describe('DeliveryReceiptRepository', () => {
  it('stores an allowlisted provider response and redacts credentials and personal data', async () => {
    const db = {
      run: jest.fn<() => Promise<{ lastID: number; changes: number }>>().mockResolvedValue({
        lastID: 5,
        changes: 1,
      }),
      all: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    } as unknown as Database;
    const receipts = new DeliveryReceiptRepository(db);

    await receipts.create({
      notificationId: 8,
      channel: 'webhook',
      status: 'failed',
      attemptCount: 2,
      providerMessageId: null,
      providerResponse: {
        statusCode: 503,
        messageId: 'provider-msg-1',
        authorization: 'Bearer do-not-store',
        email: 'person@example.com',
      },
      errorCode: 'token=do-not-store',
      errorMessage: 'Request failed for https://example.com/hook?token=secret',
    });

    const parameters = (db.run as jest.Mock).mock.calls[0][1] as unknown[];
    expect(parameters[5]).toBe(JSON.stringify({ statusCode: 503, messageId: 'provider-msg-1' }));
    expect(parameters[6]).toBe('DELIVERY_FAILED');
    expect(parameters[7]).toBe('Request failed for [REDACTED_URL]');
    expect(JSON.stringify(parameters)).not.toContain('do-not-store');
    expect(JSON.stringify(parameters)).not.toContain('person@example.com');
    expect(JSON.stringify(parameters)).not.toContain('secret');
  });

  it('filters receipts by notification and status', async () => {
    const db = {
      run: jest.fn(),
      all: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    } as unknown as Database;
    const receipts = new DeliveryReceiptRepository(db);

    await receipts.findByNotificationId(8, 'delivered');
    await receipts.findByStatus('failed');

    expect(db.all).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('notification_id = ? AND status = ?'),
      [8, 'delivered'],
    );
    expect(db.all).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE status = ?'), [
      'failed',
    ]);
  });
});
