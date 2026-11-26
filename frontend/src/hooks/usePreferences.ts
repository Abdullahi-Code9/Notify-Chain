/**
 * usePreferences – React hook for reading and updating notification preferences.
 *
 * Communicates with the Soroban AutoShare contract preference functions.
 * Follows the loading/error/success state pattern required by Issue #178.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  CategoryPreference,
  ChannelPreference,
  DeliveryChannel,
  NotificationCategory,
  QuietHours,
  RecipientPreferences,
} from "../types/preferences";
import { DEFAULT_PREFERENCES } from "../types/preferences";
import { preferenceService } from "../services/preferenceService";

export type PreferencesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: RecipientPreferences }
  | { status: "error"; error: string };

export interface UsePreferencesReturn {
  state: PreferencesState;
  /** Reload preferences from the contract */
  refresh: () => Promise<void>;
  /** Toggle a single delivery channel */
  setChannel: (channel: DeliveryChannel, enabled: boolean) => Promise<void>;
  /** Toggle a single notification category */
  setCategory: (category: NotificationCategory, enabled: boolean) => Promise<void>;
  /** Atomically update all channels and categories */
  setAll: (
    channels: ChannelPreference[],
    categories: CategoryPreference[]
  ) => Promise<void>;
  /** Update the user's quiet hours (timezone-aware delivery window) */
  setQuietHours: (quietHours: QuietHours | null) => Promise<void>;
  /** Reset everything to the all-enabled defaults */
  reset: () => Promise<void>;
}

export function usePreferences(recipient: string | null): UsePreferencesReturn {
  const [state, setState] = useState<PreferencesState>({ status: "idle" });

  const refresh = useCallback(async () => {
    if (!recipient) return;
    setState({ status: "loading" });
    try {
      const data = await preferenceService.getPreferences(recipient);
      setState({ status: "success", data });
    } catch (err) {
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "Failed to load preferences",
      });
    }
  }, [recipient]);

  // Load on mount / when recipient changes
  useEffect(() => {
    refresh();
  }, [refresh]);

  const setChannel = useCallback(
    async (channel: DeliveryChannel, enabled: boolean) => {
      if (!recipient || state.status !== "success") return;
      // Optimistic update
      const prev = state.data;
      const updatedChannels = prev.channels.map((c) =>
        c.channel === channel ? { ...c, enabled } : c
      );
      setState({
        status: "success",
        data: { ...prev, channels: updatedChannels },
      });
      try {
        await preferenceService.setChannelPreference(recipient, channel, enabled);
      } catch (err) {
        // Revert optimistic update
        setState({ status: "success", data: prev });
        throw err;
      }
    },
    [recipient, state]
  );

  const setCategory = useCallback(
    async (category: NotificationCategory, enabled: boolean) => {
      if (!recipient || state.status !== "success") return;
      const prev = state.data;
      const updatedCategories = prev.categories.map((c) =>
        c.category === category ? { ...c, enabled } : c
      );
      setState({
        status: "success",
        data: { ...prev, categories: updatedCategories },
      });
      try {
        await preferenceService.setCategoryPreference(recipient, category, enabled);
      } catch (err) {
        setState({ status: "success", data: prev });
        throw err;
      }
    },
    [recipient, state]
  );

  const setAll = useCallback(
    async (channels: ChannelPreference[], categories: CategoryPreference[]) => {
      if (!recipient || state.status !== "success") return;
      const prev = state.data;
      setState({
        status: "success",
        data: { ...prev, channels, categories },
      });
      try {
        await preferenceService.setPreferences(recipient, channels, categories);
      } catch (err) {
        setState({ status: "success", data: prev });
        throw err;
      }
    },
    [recipient, state]
  );

  const setQuietHours = useCallback(
    async (quietHours: QuietHours | null) => {
      if (!recipient || state.status !== "success") return;
      const prev = state.data;
      setState({
        status: "success",
        data: { ...prev, quietHours },
      });
      try {
        await preferenceService.setQuietHours(recipient, quietHours);
      } catch (err) {
        setState({ status: "success", data: prev });
        throw err;
      }
    },
    [recipient, state]
  );

  const reset = useCallback(async () => {
    if (!recipient || state.status !== "success") return;
    const prev = state.data;
    setState({
      status: "success",
      data: {
        ...prev,
        ...DEFAULT_PREFERENCES,
      },
    });
    try {
      await preferenceService.resetPreferences(recipient);
    } catch (err) {
      setState({ status: "success", data: prev });
      throw err;
    }
  }, [recipient, state]);

  return { state, refresh, setChannel, setCategory, setAll, setQuietHours, reset };
}
