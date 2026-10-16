export type DeliveryReceiptStatus = 'delivered' | 'failed' | 'rejected' | 'pending';

export interface DeliveryReceipt {
  id: number;
  notificationId: number;
  channel: string;
  status: DeliveryReceiptStatus;
  attemptCount: number;
  providerMessageId: string | null;
  providerResponse: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateDeliveryReceiptInput = Omit<
  DeliveryReceipt,
  'id' | 'providerResponse' | 'createdAt' | 'updatedAt'
> & { providerResponse?: unknown };

export interface DeliveryReceiptRow {
  id: number;
  notification_id: number;
  channel: string;
  status: DeliveryReceiptStatus;
  attempt_count: number;
  provider_message_id: string | null;
  provider_response: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
