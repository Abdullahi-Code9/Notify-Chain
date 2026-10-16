import * as StellarSDK from '@stellar/stellar-sdk';
import { ContractConfig, NotificationProvider } from '../types';

export class MockNotificationProvider implements NotificationProvider {
  public sentEvents: StellarSDK.rpc.Api.EventResponse[] = [];
  public sentTestMessagesCount: number = 0;

  async sendEventNotification(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId?: string
  ): Promise<boolean> {
    this.sentEvents.push(event);
    return true;
  }

  async sendTestMessage(requestId?: string): Promise<boolean> {
    this.sentTestMessagesCount++;
    return true;
  }
}
