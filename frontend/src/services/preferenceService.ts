/**
 * preferenceService – thin wrapper over the Soroban contract client for
 * notification preferences (Issue #178).
 *
 * Replace the placeholder `invokeContract` stubs with the actual
 * @stellar/stellar-sdk / soroban-client calls once the contract is deployed.
 */
import type {
  CategoryPreference,
  ChannelPreference,
  DeliveryChannel,
  DeliveryWindow,
  NotificationCategory,
  QuietHours,
  RecipientPreferences,
} from "../types/preferences";
import { DEFAULT_PREFERENCES } from "../types/preferences";

// ---------------------------------------------------------------------------
// Contract invocation helper (stub — swap for real Soroban client)
// ---------------------------------------------------------------------------

/** Replace with your deployed contract ID on Testnet / Mainnet */
const CONTRACT_ID = process.env.REACT_APP_PREFERENCE_CONTRACT_ID ?? "";

/**
 * Thin invocation wrapper.  In production this calls the Soroban RPC
 * using @stellar/stellar-sdk's `rpc.Server` and `Contract` helpers.
 * Here it is a typed stub to keep the interface clean.
 */
async function invokeContract<T>(
  fnName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, unknown>
): Promise<T> {
  // TODO: replace with real Soroban RPC invocation, e.g.:
  // const server = new SorobanRpc.Server(NETWORK_RPC_URL);
  // const contract = new Contract(CONTRACT_ID);
  // const tx = new TransactionBuilder(account, { fee, networkPassphrase })
  //   .addOperation(contract.call(fnName, ...sorobanArgs))
  //   .setTimeout(30).build();
  // const result = await server.simulateTransaction(tx);
  // ...
  throw new Error(
    `invokeContract(${fnName}) is a stub — wire up the Soroban client. Args: ${JSON.stringify(args)}`
  );
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

export const preferenceService = {
  /**
   * Fetch all notification preferences for `recipient` from the contract.
   * Falls back to all-enabled defaults if the recipient has no stored prefs.
   */
  async getPreferences(recipient: string): Promise<RecipientPreferences> {
    try {
      return await invokeContract<RecipientPreferences>("get_preferences", {
        recipient,
      });
    } catch {
      // Network unavailable or no on-chain prefs yet — return client-side defaults
      return {
        recipient,
        updated_at: Date.now(),
        ...DEFAULT_PREFERENCES,
      };
    }
  },

  /**
   * Atomically replace all channel and category preferences, including
   * quiet hours and delivery windows (Issue #1227).
   * Requires the recipient's wallet to sign the transaction.
   */
  async setPreferences(
    recipient: string,
    channels: ChannelPreference[],
    categories: CategoryPreference[],
    quietHours?: QuietHours,
    deliveryWindow?: DeliveryWindow
  ): Promise<void> {
    await invokeContract<void>("set_preferences", {
      recipient,
      channels,
      categories,
      quiet_hours: quietHours,
      delivery_window: deliveryWindow,
    });
  },

  /**
   * Toggle a single delivery channel.
   * Requires the recipient's wallet to sign the transaction.
   */
  async setChannelPreference(
    recipient: string,
    channel: DeliveryChannel,
    enabled: boolean
  ): Promise<void> {
    await invokeContract<void>("set_channel_preference", {
      recipient,
      channel,
      enabled,
    });
  },

  /**
   * Toggle a single notification category.
   * Requires the recipient's wallet to sign the transaction.
   */
  async setCategoryPreference(
    recipient: string,
    category: NotificationCategory,
    enabled: boolean
  ): Promise<void> {
    await invokeContract<void>("set_category_preference", {
      recipient,
      category,
      enabled,
    });
  },

  /**
   * Configure user-specific quiet hours (Issue #1227).
   * Events received during quiet hours are preserved and delivered once the
   * window opens — they are never discarded.
   * Requires the recipient's wallet to sign the transaction.
   */
  async setQuietHours(recipient: string, quietHours: QuietHours): Promise<void> {
    await invokeContract<void>("set_quiet_hours", {
      recipient,
      quiet_hours: quietHours,
    });
  },

  /**
   * Configure the timezone-aware delivery window (Issue #1227).
   * Requires the recipient's wallet to sign the transaction.
   */
  async setDeliveryWindow(
    recipient: string,
    deliveryWindow: DeliveryWindow
  ): Promise<void> {
    await invokeContract<void>("set_delivery_window", {
      recipient,
      delivery_window: deliveryWindow,
    });
  },

  /**
   * Reset all preferences to the all-enabled defaults.
   * Requires the recipient's wallet to sign the transaction.
   */
  async resetPreferences(recipient: string): Promise<void> {
    await invokeContract<void>("reset_preferences", { recipient });
  },
};