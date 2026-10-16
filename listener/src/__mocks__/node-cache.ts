/**
 * Manual mock for node-cache.
 * Used by Jest (via moduleNameMapper) when the real package is not installed.
 */

class NodeCache {
  private store: Map<string, { value: any; expiresAt?: number }> = new Map();
  private listeners: Map<string, ((...args: any[]) => void)[]> = new Map();
  private stdTTL: number = 0;

  constructor(options?: { stdTTL?: number; checkperiod?: number }) {
    this.stdTTL = (options?.stdTTL ?? 0) * 1000;
  }

  get<T>(key: string): T | undefined {
    const item = this.store.get(key);
    if (!item) return undefined;
    if (item.expiresAt && Date.now() >= item.expiresAt) {
      this.store.delete(key);
      const callbacks = this.listeners.get('expired') ?? [];
      callbacks.forEach((cb) => cb(key, item.value));
      return undefined;
    }
    return item.value as T;
  }

  set(key: string, value: any, ttl?: number): boolean {
    const ttlMs = ttl !== undefined ? ttl * 1000 : this.stdTTL;
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : undefined;
    this.store.set(key, { value, expiresAt });
    return true;
  }

  del(key: string | string[]): number {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  flushAll(): void {
    this.store.clear();
  }

  getStats() {
    return { hits: 0, misses: 0, keys: this.store.size, ksize: 0, vsize: 0 };
  }

  on(event: string, callback: (...args: any[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...existing, callback]);
    return this;
  }
}

export default NodeCache;
