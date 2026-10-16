import NodeCache from 'node-cache';
import logger from '../utils/logger';

/**
 * Operational metrics for notification queue activity (#797).
 */
export interface QueueOperationalMetrics {
  /** Number of notifications currently pending delivery in queue. */
  pendingNotifications: number;
  /** Number of notifications currently being processed. */
  processingNotifications: number;
  /** Total count of successfully delivered notifications. */
  successfulDeliveries: number;
  /** Total count of permanently failed deliveries. */
  failedDeliveries: number;
  /** Total count of retry attempts across all notifications. */
  retryAttempts: number;
}

/**
 * Statistics snapshot for notification scheduler, enriched with queue operational metrics (#797).
 */
export interface NotificationStats extends Partial<QueueOperationalMetrics> {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  overdue: number;
  deadLetterQueue: number;
}

/**
 * Cache statistics for monitoring hit rate
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  keys: number;
}

/**
 * @notice In-memory cache layer for notification statistics.
 * @dev Uses node-cache with TTL-based expiration and manual invalidation.
 * Follows the same pattern as NotificationTemplateCache.
 */
export class NotificationStatsCache {
  private cache: NodeCache;
  private hits = 0;
  private misses = 0;
  private readonly CACHE_KEY = 'notification_stats';

  /**
   * @param ttlSeconds - Time-to-live for cached entries (default: 30s)
   * @param checkPeriodSeconds - How often to check for expired entries (default: 10s)
   */
  constructor(
    private readonly ttlSeconds: number = 30,
    checkPeriodSeconds: number = 10,
  ) {
    this.cache = new NodeCache({
      stdTTL: ttlSeconds,
      checkperiod: checkPeriodSeconds,
      useClones: false,
    });

    this.cache.on('expired', (key: string) => {
      logger.debug('[StatsCache] Entry expired', { key });
    });
  }

  /**
   * @notice Get statistics from cache
   * @returns Cached stats or undefined if not found/expired
   */
  get(): NotificationStats | undefined {
    const value = this.cache.get<NotificationStats>(this.CACHE_KEY);
    if (value !== undefined) {
      this.hits++;
      logger.debug('[StatsCache] Cache hit');
      return value;
    }
    this.misses++;
    logger.debug('[StatsCache] Cache miss');
    return undefined;
  }

  /**
   * @notice Store statistics in cache
   * @param stats - Statistics data to cache
   * @param ttl - Optional custom TTL in seconds
   */
  set(stats: NotificationStats, ttl?: number): void {
    const success =
      ttl !== undefined
        ? this.cache.set(this.CACHE_KEY, stats, ttl)
        : this.cache.set(this.CACHE_KEY, stats);

    if (success) {
      logger.debug('[StatsCache] Stats cached', { ttl: ttl ?? this.ttlSeconds });
    } else {
      logger.warn('[StatsCache] Failed to cache stats');
    }
  }

  /**
   * @notice Get from cache or fetch from source using provided loader
   * @dev This is the primary access pattern
   * @param loader - Async function to load stats if not in cache
   * @param ttl - Optional custom TTL in seconds
   */
  async getOrLoad(
    loader: () => Promise<NotificationStats>,
    ttl?: number,
  ): Promise<NotificationStats> {
    const cached = this.get();
    if (cached !== undefined) {
      return cached;
    }

    const stats = await loader();
    this.set(stats, ttl);
    return stats;
  }

  /**
   * @notice Invalidate the cached statistics
   * @dev Called when notification status changes occur
   */
  invalidate(): void {
    const deleted = this.cache.del(this.CACHE_KEY);
    if (deleted > 0) {
      logger.debug('[StatsCache] Stats invalidated');
    }
  }

  /**
   * @notice Get cache performance statistics
   * @returns Cache hit rate and storage metrics
   */
  getStats(): CacheStats {
    const nodeStats = this.cache.getStats();
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      keys: nodeStats.keys,
    };
  }

  /**
   * @notice Reset hit/miss counters
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * @notice Check if stats are currently cached
   */
  has(): boolean {
    return this.cache.get(this.CACHE_KEY) !== undefined;
    return (this.cache as any).has(this.CACHE_KEY);
  }

  /**
   * @notice Flush all cached data (useful for testing)
   */
  flush(): void {
    this.cache.flushAll();
    logger.debug('[StatsCache] Cache flushed');
  }
}

// Singleton instance for application-wide use
let instance: NotificationStatsCache | null = null;

/**
 * @notice Get the singleton cache instance
 * @param ttlSeconds - TTL for cache entries (only used on first call)
 */
export function getStatsCache(ttlSeconds?: number): NotificationStatsCache {
  if (!instance) {
    instance = new NotificationStatsCache(ttlSeconds);
  }
  return instance;
}

/**
 * @notice Reset the singleton (useful for testing)
 */
export function resetStatsCache(): void {
  instance = null;
}
