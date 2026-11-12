/**
 * Cache Types for fetch-undici
 *
 * Core interfaces for the caching middleware.
 */

import type { Logger } from '../logger.js'

/**
 * Request context for cache key generation
 */
export interface RequestContext {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  params?: Record<string, unknown>
}

/**
 * Cache key generation strategy
 *
 * @example
 * ```typescript
 * // Default strategy: METHOD:URL
 * const defaultStrategy: CacheKeyStrategy = (method, url) => `${method}:${url}`
 *
 * // Custom strategy with dot notation
 * const customStrategy = createDotNotationKeyStrategy(['headers.Authorization'])
 * ```
 */
export type CacheKeyStrategy = (
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: unknown,
  params?: Record<string, unknown>
) => string

/**
 * Metadata stored with each cache entry
 */
export interface CacheEntryMetadata {
  statusCode: number
  /** Original response headers; repeated headers (e.g. Set-Cookie) are stored as arrays */
  headers: Record<string, string | string[]>
  url: string
  method: string
  contentType?: string
  /** Body size in bytes */
  size?: number
  /**
   * Encoding of `CacheEntry.data` when it holds a raw body.
   * Omitted for UTF-8 text; `'base64'` for bodies that are not valid UTF-8.
   */
  encoding?: 'base64'
}

/**
 * Cache entry structure
 *
 * Entries written by CacheManager store the raw response body in `data`
 * (UTF-8 text, or base64 when `metadata.encoding` is `'base64'`), so cache hits
 * return the origin bytes unchanged. Non-string `data` (e.g. from a custom
 * storage) is serialised with JSON.stringify when a response is rebuilt.
 */
export interface CacheEntry<T = unknown> {
  key: string
  data: T
  createdAt: number
  /** End of freshness; after this the entry is stale */
  expiresAt: number
  /**
   * Storage retention deadline (stale-while-revalidate). Storages should keep
   * the entry until `max(expiresAt, staleUntil)`. Omitted when SWR is disabled.
   */
  staleUntil?: number
  metadata: CacheEntryMetadata
}

/**
 * Cache statistics
 */
export interface CacheStats {
  size: number
  hits: number
  misses: number
  evictions: number
}

/**
 * Statistics reported by CacheManager
 *
 * `hits`/`misses` are counted by the manager itself (one per lookup), so they
 * are accurate for any storage backend; `size`/`evictions` come from storage.
 */
export interface CacheManagerStats extends CacheStats {
  /** hits / (hits + misses), or 0 before any lookup */
  hitRate: number
}

/**
 * Cache storage interface
 *
 * Implement this for custom backends (Redis, file, etc.)
 *
 * @example
 * ```typescript
 * class RedisStorage implements CacheStorage {
 *   async get(key: string) { ... }
 *   async set(key: string, entry: CacheEntry) { ... }
 *   // ... other methods
 * }
 * ```
 */
export interface CacheStorage<T = unknown> {
  /** Get an entry by key */
  get(key: string): Promise<CacheEntry<T> | undefined>

  /** Set an entry */
  set(key: string, entry: CacheEntry<T>): Promise<void>

  /** Check if key exists and is not expired */
  has(key: string): Promise<boolean>

  /** Delete a single key */
  delete(key: string): Promise<boolean>

  /** Delete keys matching a pattern (regex or glob) */
  deletePattern(pattern: string | RegExp): Promise<number>

  /** Clear all entries */
  clear(): Promise<void>

  /** Get all keys (optionally matching pattern) */
  keys(pattern?: string | RegExp): Promise<string[]>

  /** Get storage statistics */
  stats(): Promise<CacheStats>

  /** Close/cleanup storage */
  close(): Promise<void>
}

/**
 * Cache configuration options
 */
export interface CacheConfig {
  /** Default TTL in milliseconds (default: 60000 = 1 minute) */
  ttl?: number

  /** Cache storage backend (default: in-memory) */
  storage?: CacheStorage

  /** Cache key generation strategy */
  keyStrategy?: CacheKeyStrategy

  /** HTTP methods to cache (default: ['GET', 'HEAD']) */
  methods?: string[]

  /** Maximum entries in cache (default: 1000, in-memory only; 0 disables storing) */
  maxEntries?: number

  /** Enable stale-while-revalidate (default: false) */
  staleWhileRevalidate?: boolean

  /** Grace period for stale-while-revalidate in ms (default: 30000) */
  staleGracePeriod?: number

  /** Custom logger */
  logger?: Logger
}

/**
 * Per-request cache options
 */
export interface RequestCacheOptions {
  /** Override TTL for this request */
  ttl?: number

  /** Skip cache for this request */
  noCache?: boolean

  /** Force refresh (bypass read, still write) */
  forceRefresh?: boolean

  /** Custom cache key for this request */
  cacheKey?: string
}
