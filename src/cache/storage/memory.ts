/**
 * In-Memory Cache Storage
 *
 * Default storage backend using Map with TTL support and automatic cleanup.
 */

import { logger, type Logger } from '../../logger.js'
import type { CacheStorage, CacheEntry, CacheStats } from '../types.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Memory storage options
 */
export interface MemoryStorageOptions {
  /** Maximum number of entries (default: 1000; 0 or less stores nothing) */
  maxEntries?: number
  /** Cleanup interval in ms (default: 60000) */
  cleanupInterval?: number
  /** Custom logger */
  logger?: Logger
}

/**
 * Convert a glob pattern to an anchored regular expression
 *
 * Every character is literal except `*`:
 * - `*` matches any run of characters, including `:` and `/`
 *   (so `GET:*users*` matches `GET:https://api.example.com/users`)
 * - `**` is accepted as an alias of `*`
 * - `?`, `.`, `+`, `(`, `[` and other regex metacharacters match themselves,
 *   so URL keys with query strings can be matched literally
 *
 * @example
 * ```typescript
 * globToRegExp('GET:*users*').test('GET:https://api.example.com/users?page=1') // true
 * globToRegExp('GET:/users?page=1').test('GET:/users?page=1') // true
 * ```
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/\*+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`)
}

/**
 * Build a key matcher from a glob string or RegExp
 *
 * RegExp patterns are used without the `g`/`y` flags so `lastIndex` state
 * never causes keys to be skipped.
 */
function toMatcher(pattern: string | RegExp): (key: string) => boolean {
  const regex =
    typeof pattern === 'string'
      ? globToRegExp(pattern)
      : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  return (key) => regex.test(key)
}

/**
 * In-memory cache storage with TTL support
 *
 * Features:
 * - Automatic expired entry cleanup
 * - LRU eviction when at capacity (`get` and `set` refresh recency)
 * - Glob/RegExp pattern matching for listing and bulk deletion
 * - Entries are retained until `max(expiresAt, staleUntil)` so CacheManager
 *   can serve stale-while-revalidate responses
 *
 * @example
 * ```typescript
 * const storage = new MemoryStorage({ maxEntries: 500 })
 *
 * await storage.set('key', { data: 'value', ... })
 * const entry = await storage.get('key')
 *
 * await storage.deletePattern('user:*')
 * await storage.close()
 * ```
 */
export class MemoryStorage<T = unknown> implements CacheStorage<T> {
  /** Entries in recency order: first = least recently used */
  private readonly _cache = new Map<string, CacheEntry<T>>()
  private readonly _maxEntries: number
  private readonly _log: Logger
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null
  private _stats: CacheStats = { size: 0, hits: 0, misses: 0, evictions: 0 }

  constructor(options?: MemoryStorageOptions) {
    this._maxEntries = options?.maxEntries ?? 1000
    this._log = options?.logger ?? log

    // Start cleanup timer
    const interval = options?.cleanupInterval ?? 60000
    this._cleanupTimer = setInterval(() => this._cleanup(), interval)
    this._cleanupTimer.unref() // Don't keep process alive

    this._log.debug('MemoryStorage created', { maxEntries: this._maxEntries })
  }

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    const entry = this._cache.get(key)

    if (!entry) {
      this._stats.misses++
      return undefined
    }

    if (this._isExpired(entry, Date.now())) {
      this._cache.delete(key)
      this._stats.misses++
      this._stats.evictions++
      this._stats.size = this._cache.size
      return undefined
    }

    // Refresh recency (LRU)
    this._cache.delete(key)
    this._cache.set(key, entry)

    this._stats.hits++
    return entry
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    if (this._maxEntries <= 0) {
      this._log.trace('Cache set skipped (maxEntries <= 0)', { key })
      return
    }

    // Re-inserting moves the key to the most-recently-used position
    const existed = this._cache.delete(key)

    // Evict if at capacity
    if (!existed && this._cache.size >= this._maxEntries) {
      this._evictLeastRecentlyUsed()
    }

    this._cache.set(key, entry)
    this._stats.size = this._cache.size
    this._log.trace('Cache set', { key, expiresAt: entry.expiresAt })
  }

  /**
   * Check whether a live entry exists (does not affect stats or recency)
   */
  async has(key: string): Promise<boolean> {
    const entry = this._cache.get(key)
    return entry !== undefined && !this._isExpired(entry, Date.now())
  }

  async delete(key: string): Promise<boolean> {
    const deleted = this._cache.delete(key)
    this._stats.size = this._cache.size
    return deleted
  }

  async deletePattern(pattern: string | RegExp): Promise<number> {
    const matches = toMatcher(pattern)

    let count = 0
    for (const key of Array.from(this._cache.keys())) {
      if (matches(key)) {
        this._cache.delete(key)
        count++
      }
    }
    this._stats.size = this._cache.size
    this._log.debug('Deleted by pattern', { pattern: String(pattern), count })
    return count
  }

  async clear(): Promise<void> {
    this._cache.clear()
    this._stats.size = 0
    this._log.debug('Cache cleared')
  }

  /**
   * List keys of live (non-expired) entries, optionally filtered by pattern
   */
  async keys(pattern?: string | RegExp): Promise<string[]> {
    const now = Date.now()
    const live: string[] = []
    for (const [key, entry] of this._cache) {
      if (!this._isExpired(entry, now)) live.push(key)
    }
    if (!pattern) return live

    const matches = toMatcher(pattern)
    return live.filter(matches)
  }

  async stats(): Promise<CacheStats> {
    return { ...this._stats }
  }

  async close(): Promise<void> {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
    this._cache.clear()
    this._stats.size = 0
    this._log.debug('MemoryStorage closed')
  }

  /**
   * An entry is expired once both its freshness and stale window have passed
   */
  private _isExpired(entry: CacheEntry<T>, now: number): boolean {
    return now > Math.max(entry.expiresAt, entry.staleUntil ?? entry.expiresAt)
  }

  /**
   * Clean up expired entries
   */
  private _cleanup(): void {
    const now = Date.now()
    let evicted = 0

    for (const [key, entry] of Array.from(this._cache)) {
      if (this._isExpired(entry, now)) {
        this._cache.delete(key)
        evicted++
      }
    }

    if (evicted > 0) {
      this._stats.evictions += evicted
      this._stats.size = this._cache.size
      this._log.trace('Cleanup evicted expired entries', { count: evicted })
    }
  }

  /**
   * Evict the least recently used entry (first in Map order)
   */
  private _evictLeastRecentlyUsed(): void {
    // Only called when size >= maxEntries >= 1, so the map is non-empty
    const oldest = this._cache.keys().next().value as string
    this._cache.delete(oldest)
    this._stats.evictions++
    this._log.trace('Evicted oldest entry', { key: oldest })
  }
}
