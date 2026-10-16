import * as StellarSDK from '@stellar/stellar-sdk';
import { ExpirationConfig } from '../types';
import logger from '../utils/logger';

/**
 * NotificationExpirationService handles expiration checks for notifications.
 * 
 * This service:
 * - Checks if notifications have exceeded their expiration timestamp
 * - Supports configurable default expiration (24 hours by default)
 * - Supports per-event-type expiration overrides
 * - Can be disabled via configuration for backward compatibility
 */
export class NotificationExpirationService {
  private config: ExpirationConfig;

  constructor(config: ExpirationConfig) {
    this.config = config;
  }

  /**
   * Check if a notification has expired based on its receivedAt timestamp
   * and the appropriate expiration time.
   * 
   * @param event - The blockchain event to check
   * @returns true if the event has expired, false otherwise
   */
  isExpired(event: StellarSDK.rpc.Api.EventResponse, eventType?: string): boolean {
    // If expiration is disabled, nothing is ever expired
    if (!this.config.enabled) {
      return false;
    }

    // Get the expiration time in milliseconds for this event
    const expirationTimeMs = this.getExpirationTime(eventType);
    
    // Calculate when this event should expire
    // receivedAt is in milliseconds (Unix timestamp)
    const expiresAtMs = event.receivedAt + expirationTimeMs;

    // Check if current time exceeds the expiration time
    const currentTimeMs = Date.now();
    return currentTimeMs > expiresAtMs;
  }

  /**
   * Determine if an event should be processed based on expiration status.
   * 
   * This is the main entry point for checking if an event is still valid.
   * 
   * @param event - The blockchain event to check
   * @param eventType - Optional event type for per-type expiration lookup
   * @returns true if the event should be processed, false if expired
   */
  shouldProcess(
    event: StellarSDK.rpc.Api.EventResponse,
    eventType?: string
  ): boolean {
    // If expiration is disabled, always process
    if (!this.config.enabled) {
      return true;
    }

    const expired = this.isExpired(event, eventType);
    
    if (expired) {
      logger.warn('Event skipped due to expiration', {
        eventId: event.id,
        receivedAt: event.receivedAt,
        eventType,
        currentTime: Date.now(),
      });
    }

    return !expired;
  }

  /**
   * Get the expiration time in milliseconds for a given event type.
   * 
   * Uses per-event-type configuration if available, otherwise uses default.
   * 
   * @param eventType - Optional event type to look up specific expiration time
   * @returns Expiration time in milliseconds
   */
  getExpirationTime(eventType?: string): number {
    // If an event type is provided, check for per-type expiration
    if (eventType && this.config.perEventTypeExpiration) {
      const perTypeExpiration = this.config.perEventTypeExpiration[eventType];
      if (perTypeExpiration !== undefined) {
        return perTypeExpiration;
      }
    }

    // Return default expiration
    return this.config.defaultExpirationMs;
  }

  /**
   * Get the current configuration.
   * 
   * @returns The expiration configuration
   */
  getConfig(): ExpirationConfig {
    return this.config;
  }

  /**
   * Update the configuration at runtime.
   * 
   * @param config - New expiration configuration
   */
  setConfig(config: ExpirationConfig): void {
    this.config = config;
  }
}
