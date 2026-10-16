import NodeCache from 'node-cache';
import logger from '../utils/logger';
import { AuditedNotificationTemplate } from '../types/notification-template';

export type { AuditedNotificationTemplate } from '../types/notification-template';

/**
 * Cache statistics for monitoring hit rate
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  keys: number;
  ksize: number;
  vsize: number;
}

/**
 * @notice In-memory cache layer for notification templates.
 * @dev Uses node-cache with TTL-based expiration and manual invalidation.
 * Cache hit rate is tracked for performance measurement.
 */
export class NotificationTemplateCache {
  private cache: NodeCache;
  private hits = 0;
  private misses = 0;

  /**
   * @param ttlSeconds - Time-to-live for cached entries (default: 300s / 5 minutes)
   * @param checkPeriodSeconds - How often to check for expired entries (default: 60s)
   */
  constructor(
    private readonly ttlSeconds: number = 300,
    checkPeriodSeconds: number = 60,
  ) {
    this.cache = new NodeCache({
      stdTTL: ttlSeconds,
      checkperiod: checkPeriodSeconds,
      useClones: false,
    });

    this.cache.on('expired', (key: string) => {
      logger.info('[TemplateCache] Entry expired', { key });
    });
  }

  /**
   * @notice Get a template from cache
   * @param templateId - The template identifier
   * @returns Cached template or undefined if not found/expired
   */
  get(templateId: string): AuditedNotificationTemplate | undefined {
    const value = this.cache.get<AuditedNotificationTemplate>(templateId);
    if (value !== undefined) {
      this.hits++;
      logger.debug('[TemplateCache] Cache hit', { templateId });
      return value;
    }
    this.misses++;
    logger.debug('[TemplateCache] Cache miss', { templateId });
    return undefined;
  }

  /**
   * @notice Store a template in cache
   * @param templateId - The template identifier
   * @param template - Template data to cache
   * @param ttl - Optional custom TTL in seconds
   */
  set(templateId: string, template: AuditedNotificationTemplate, ttl?: number): void {
    const success = ttl !== undefined
      ? this.cache.set(templateId, template, ttl)
      : this.cache.set(templateId, template);

    if (success) {
      logger.info('[TemplateCache] Template cached', { templateId, ttl: ttl ?? this.ttlSeconds });
    } else {
      logger.warn('[TemplateCache] Failed to cache template', { templateId });
    }
  }

  /**
   * @notice Get from cache or fetch from source using provided loader
   * @dev This is the primary access pattern — always use this over get/set separately
   * @param templateId - The template identifier
   * @param loader - Async function to load template if not in cache
   * @param ttl - Optional custom TTL in seconds
   */
  async getOrLoad(
    templateId: string,
    loader: () => Promise<AuditedNotificationTemplate | undefined>,
    ttl?: number,
  ): Promise<AuditedNotificationTemplate | undefined> {
    const cached = this.get(templateId);
    if (cached !== undefined) {
      return cached;
    }

    const template = await loader();
    if (template !== undefined) {
      this.set(templateId, template, ttl);
    }
    return template;
  }

  /**
   * @notice Invalidate a single cached template
   * @param templateId - The template identifier to invalidate
   */
  invalidate(templateId: string): void {
    const deleted = this.cache.del(templateId);
    logger.info('[TemplateCache] Template invalidated', { templateId, deleted });
  }

  /**
   * @notice Invalidate all cached templates
   */
  invalidateAll(): void {
    this.cache.flushAll();
    logger.info('[TemplateCache] All templates invalidated');
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
      ksize: nodeStats.ksize,
      vsize: nodeStats.vsize,
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
   * @notice Check if a template is currently cached
   */
  has(templateId: string): boolean {
    // @types/node-cache (stub, v4.1) predates the real library's `.has()`
    // method, so the cast is required even though it exists at runtime
    // (see src/__mocks__/node-cache.ts, used in tests via moduleNameMapper).
    return (this.cache as unknown as { has(key: string): boolean }).has(templateId);
  }
}

// Singleton instance for application-wide use
let instance: NotificationTemplateCache | null = null;

/**
 * @notice Get the singleton cache instance
 * @param ttlSeconds - TTL for cache entries (only used on first call)
 */
export function getTemplateCache(ttlSeconds?: number): NotificationTemplateCache {
  if (!instance) {
    instance = new NotificationTemplateCache(ttlSeconds);
  }
  return instance;
}

/**
 * @notice Reset the singleton (useful for testing)
 */
export function resetTemplateCache(): void {
  instance = null;
}