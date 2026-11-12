/**
 * Cache Manager
 *
 * Core cache logic for managing cached responses.
 */

import { Response } from '../../models/response.js'
import type { Headers } from '../../models/headers.js'
import { Request, type HttpMethod } from '../../models/request.js'
import { logger, type Logger } from '../../logger.js'
import { MemoryStorage } from '../storage/memory.js'
import type {
  CacheConfig,
  CacheStorage,
  CacheEntry,
  CacheEntryMetadata,
  CacheKeyStrategy,
  CacheManagerStats,
  RequestCacheOptions
} from '../types.js'
import { defaultKeyStrategy } from './key-strategy.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Fully buffered copy of a response, used to build fresh Response objects
 */
interface ResponseSnapshot {
  statusCode: number
  headers: Record<string, string | string[]>
  body: Buffer
  request?: Request
  history: Response[]
}

/**
 * How a cache lookup was satisfied
 * - `hit`: fresh cache entry
 * - `stale`: stale entry served while a background refresh runs (SWR)
 * - `shared`: joined an identical in-flight request
 * - `miss`: fetched from origin
 */
export type CacheLookupStatus = 'hit' | 'stale' | 'shared' | 'miss'

/**
 * Options for CacheManager.fetchThrough / getOrFetch
 */
export interface FetchThroughOptions {
  /** TTL for the stored entry (default: manager ttl) */
  ttl?: number
  /** Skip the cache read and in-flight deduplication; still store the result */
  forceRefresh?: boolean
}

/**
 * Cache Manager - Core caching logic
 *
 * Handles cache key generation, storage operations, and response serialization.
 *
 * Responses are stored as their raw body bytes plus the original status and
 * headers (repeated headers such as Set-Cookie are kept), so cache hits return
 * exactly what the origin sent. Every Response handed out (hit or miss) is a
 * new object with a fully buffered body that can be read or streamed.
 *
 * @example
 * ```typescript
 * const manager = new CacheManager({ ttl: 60000 })
 *
 * const key = manager.generateKey('GET', 'https://api.example.com/users')
 * const response = await manager.getOrFetch(key, () => client.get('/users'))
 *
 * const cached = await manager.get(key)
 * const replay = manager.createResponseFromCache(cached!)
 * ```
 */
export class CacheManager {
  private readonly _storage: CacheStorage
  private readonly _ttl: number
  private readonly _methods: string[]
  private readonly _keyStrategy: CacheKeyStrategy
  private readonly _staleWhileRevalidate: boolean
  private readonly _staleGracePeriod: number
  private readonly _log: Logger

  /** Track in-flight requests for deduplication */
  private readonly _pending = new Map<string, Promise<ResponseSnapshot>>()

  /** Background stale-while-revalidate refreshes */
  private readonly _revalidating = new Set<Promise<void>>()

  private _hits = 0
  private _misses = 0

  constructor(config?: CacheConfig) {
    this._storage =
      config?.storage ??
      new MemoryStorage({
        maxEntries: config?.maxEntries ?? 1000
      })

    this._ttl = config?.ttl ?? 60000
    this._methods = (config?.methods ?? ['GET', 'HEAD']).map((m) => m.toUpperCase())
    this._keyStrategy = config?.keyStrategy ?? defaultKeyStrategy
    this._staleWhileRevalidate = config?.staleWhileRevalidate ?? false
    this._staleGracePeriod = config?.staleGracePeriod ?? 30000
    this._log = config?.logger ?? log

    this._log.debug('CacheManager created', {
      ttl: this._ttl,
      methods: this._methods
    })
  }

  /**
   * Generate a cache key for a request
   *
   * `headers` may be a plain object, a fetch-undici Headers instance, a Map or
   * any iterable of [name, value] pairs; non-plain inputs are converted to a
   * plain object (repeated names joined with ', ') before calling the strategy.
   */
  generateKey(
    method: string,
    url: string,
    headers?: Record<string, string> | Headers,
    body?: unknown,
    params?: Record<string, unknown>
  ): string {
    return this._keyStrategy(method, url, this._toPlainHeaders(headers), body, params)
  }

  /**
   * Check if a request should be cached
   */
  shouldCache(method: string, options?: RequestCacheOptions): boolean {
    if (options?.noCache) return false
    return this._methods.includes(method.toUpperCase())
  }

  /**
   * Get a fresh entry from cache
   *
   * Entries past `expiresAt` are a miss even if the storage still holds them
   * (e.g. retained for stale-while-revalidate).
   */
  async get(key: string): Promise<CacheEntry | undefined> {
    const stored = await this._storage.get(key)
    const entry = stored && Date.now() <= stored.expiresAt ? stored : undefined

    if (entry) {
      this._hits++
      this._log.trace('Cache hit', { key })
    } else {
      this._misses++
      this._log.trace('Cache miss', { key })
    }

    return entry
  }

  /**
   * Get with stale-while-revalidate support
   *
   * Returns a stale entry (`isStale: true`) while within `staleGracePeriod`
   * after expiry; beyond that the entry is treated as missing.
   */
  async getStale(key: string): Promise<{
    entry: CacheEntry | undefined
    isStale: boolean
  }> {
    const entry = await this._storage.get(key)

    if (!entry) {
      this._misses++
      return { entry: undefined, isStale: false }
    }

    const now = Date.now()
    const isStale = now > entry.expiresAt
    const withinGrace = now < entry.expiresAt + this._staleGracePeriod

    if (isStale && !withinGrace) {
      this._misses++
      return { entry: undefined, isStale: true }
    }

    this._hits++
    return { entry, isStale }
  }

  /**
   * Store a response in cache
   *
   * Reads the whole body. The passed response stays readable through its
   * buffered methods (text/json/bytes); the returned Response is a fresh copy
   * (same status, headers and request) that can also be streamed.
   *
   * @throws the body read error (after logging a warning); nothing is cached
   */
  async set(key: string, response: Response, ttl?: number): Promise<Response> {
    const snapshot = await this._snapshot(key, response)
    await this._store(key, snapshot, ttl)
    return this._fromSnapshot(snapshot)
  }

  /**
   * Create a Response from a cached entry
   *
   * The response carries a Request built from the entry's method and URL (when
   * the URL is absolute), so `response.url` matches the original request.
   */
  createResponseFromCache(entry: CacheEntry): Response {
    let body: Buffer | string

    if (typeof entry.data === 'string') {
      body = entry.metadata.encoding === 'base64' ? Buffer.from(entry.data, 'base64') : entry.data
    } else if (entry.data === null || entry.data === undefined) {
      body = ''
    } else {
      // Entries written by other tools/versions may hold parsed data
      body = JSON.stringify(entry.data)
    }

    return new Response({
      statusCode: entry.metadata.statusCode,
      headers: entry.metadata.headers,
      body,
      request: this._toRequest(entry.metadata)
    })
  }

  /**
   * Get or fetch with deduplication
   *
   * Prevents multiple identical requests from hitting the origin: concurrent
   * callers for the same key share one fetch (each gets its own Response).
   * With stale-while-revalidate enabled, a stale entry is returned immediately
   * and refreshed once in the background.
   */
  async getOrFetch(
    key: string,
    fetchFn: () => Promise<Response>,
    options?: FetchThroughOptions
  ): Promise<Response> {
    const { response } = await this.fetchThrough(key, fetchFn, options)
    return response
  }

  /**
   * Like getOrFetch, but also reports how the response was obtained
   */
  async fetchThrough(
    key: string,
    fetchFn: () => Promise<Response>,
    options?: FetchThroughOptions
  ): Promise<{ response: Response; status: CacheLookupStatus }> {
    if (!options?.forceRefresh) {
      if (this._staleWhileRevalidate) {
        const { entry, isStale } = await this.getStale(key)
        if (entry) {
          if (isStale) this._revalidate(key, fetchFn, options?.ttl)
          return {
            response: this.createResponseFromCache(entry),
            status: isStale ? 'stale' : 'hit'
          }
        }
      } else {
        const entry = await this.get(key)
        if (entry) {
          return { response: this.createResponseFromCache(entry), status: 'hit' }
        }
      }

      // Check if request is already in flight
      const pending = this._pending.get(key)
      if (pending) {
        this._log.trace('Deduplicating request', { key })
        return { response: this._fromSnapshot(await pending), status: 'shared' }
      }
    }

    const snapshot = await this._fetchAndStore(key, fetchFn, options?.ttl)
    return { response: this._fromSnapshot(snapshot), status: 'miss' }
  }

  /**
   * Invalidate a single cache key
   */
  async invalidate(key: string): Promise<boolean> {
    const deleted = await this._storage.delete(key)
    this._log.debug('Cache invalidated', { key, deleted })
    return deleted
  }

  /**
   * Invalidate keys matching a pattern
   *
   * For MemoryStorage, string patterns are globs where `*` matches any
   * characters (including `:` and `/`) and everything else is literal.
   */
  async invalidatePattern(pattern: string | RegExp): Promise<number> {
    const count = await this._storage.deletePattern(pattern)
    this._log.debug('Cache pattern invalidated', { pattern: String(pattern), count })
    return count
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    await this._storage.clear()
    this._log.info('Cache cleared')
  }

  /**
   * Get all cache keys
   */
  async keys(pattern?: string | RegExp): Promise<string[]> {
    return this._storage.keys(pattern)
  }

  /**
   * Get cache statistics
   *
   * `hits`/`misses` count this manager's lookups; `hitRate` is 0 before any lookup.
   */
  async stats(): Promise<CacheManagerStats> {
    const storageStats = await this._storage.stats()
    const lookups = this._hits + this._misses
    return {
      ...storageStats,
      hits: this._hits,
      misses: this._misses,
      hitRate: lookups === 0 ? 0 : this._hits / lookups
    }
  }

  /**
   * Check if stale-while-revalidate is enabled
   */
  get staleWhileRevalidateEnabled(): boolean {
    return this._staleWhileRevalidate
  }

  /**
   * Close the cache manager
   *
   * Waits for background revalidations to settle before closing storage.
   */
  async close(): Promise<void> {
    await Promise.all(this._revalidating)
    await this._storage.close()
    this._log.debug('CacheManager closed')
  }

  /**
   * Fetch from origin, store ok responses, and register the fetch as in flight
   */
  private async _fetchAndStore(
    key: string,
    fetchFn: () => Promise<Response>,
    ttl?: number
  ): Promise<ResponseSnapshot> {
    const promise = (async () => {
      const response = await fetchFn()
      const snapshot = await this._snapshot(key, response)
      if (response.ok) {
        await this._store(key, snapshot, ttl)
      }
      return snapshot
    })()

    this._pending.set(key, promise)
    try {
      return await promise
    } finally {
      if (this._pending.get(key) === promise) {
        this._pending.delete(key)
      }
    }
  }

  /**
   * Start a background refresh for a stale key (at most one per key)
   */
  private _revalidate(key: string, fetchFn: () => Promise<Response>, ttl?: number): void {
    if (this._pending.has(key)) {
      this._log.trace('Revalidation already in flight', { key })
      return
    }

    this._log.debug('Serving stale entry, revalidating in background', { key })
    const task = this._fetchAndStore(key, fetchFn, ttl).then(
      (snapshot) => {
        this._log.debug('Background revalidation finished', { key, statusCode: snapshot.statusCode })
      },
      (err: unknown) => {
        this._log.warn('Background revalidation failed', { key, error: (err as Error).message })
      }
    )
    this._revalidating.add(task)
    void task.finally(() => this._revalidating.delete(task))
  }

  /**
   * Buffer a response's body, status, headers and request
   */
  private async _snapshot(key: string, response: Response): Promise<ResponseSnapshot> {
    let body: Buffer
    try {
      body = Buffer.from(await response.arrayBuffer())
    } catch (err) {
      this._log.warn('Failed to read response body; not caching', {
        key,
        error: (err as Error).message
      })
      throw err
    }

    return {
      statusCode: response.statusCode,
      headers: this._headersToObject(response.headers),
      body,
      request: response.request,
      history: response.history
    }
  }

  /**
   * Write a snapshot to storage
   */
  private async _store(key: string, snapshot: ResponseSnapshot, ttl?: number): Promise<void> {
    const effectiveTtl = ttl ?? this._ttl
    const now = Date.now()

    const text = snapshot.body.toString('utf8')
    const isUtf8 = Buffer.from(text, 'utf8').equals(snapshot.body)
    const contentType = this._firstHeader(snapshot.headers, 'content-type')

    const metadata: CacheEntryMetadata = {
      statusCode: snapshot.statusCode,
      headers: snapshot.headers,
      url: snapshot.request?.urlString ?? '',
      method: snapshot.request?.method ?? 'GET',
      contentType,
      size: snapshot.body.length
    }
    if (!isUtf8) metadata.encoding = 'base64'

    const entry: CacheEntry = {
      key,
      data: isUtf8 ? text : snapshot.body.toString('base64'),
      createdAt: now,
      expiresAt: now + effectiveTtl,
      metadata
    }
    if (this._staleWhileRevalidate) {
      entry.staleUntil = entry.expiresAt + this._staleGracePeriod
    }

    await this._storage.set(key, entry)
    this._log.debug('Cached response', { key, ttl: effectiveTtl })
  }

  /**
   * Build a new Response from a snapshot
   */
  private _fromSnapshot(snapshot: ResponseSnapshot): Response {
    return new Response({
      statusCode: snapshot.statusCode,
      headers: snapshot.headers,
      body: snapshot.body,
      request: snapshot.request,
      history: snapshot.history
    })
  }

  /**
   * Rebuild a Request from entry metadata (undefined if the URL is not absolute)
   */
  private _toRequest(metadata: CacheEntryMetadata): Request | undefined {
    if (!metadata.url) return undefined
    try {
      return new Request(metadata.method.toUpperCase() as HttpMethod, metadata.url)
    } catch {
      return undefined
    }
  }

  /**
   * First value of a header in a stored header object (case-insensitive)
   */
  private _firstHeader(
    headers: Record<string, string | string[]>,
    name: string
  ): string | undefined {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) {
        return (Array.isArray(value) ? value[0] : value) || undefined
      }
    }
    return undefined
  }

  /**
   * Convert headers of any supported shape to a plain object
   */
  private _toPlainHeaders(
    headers?: Record<string, string> | Headers | Iterable<[string, string]>
  ): Record<string, string> | undefined {
    if (!headers) return undefined

    const proto = Object.getPrototypeOf(headers) as unknown
    if (proto === Object.prototype || proto === null) {
      return headers as Record<string, string>
    }

    if (typeof (headers as Iterable<unknown>)[Symbol.iterator] !== 'function') {
      return headers as Record<string, string>
    }

    const map = new Map<string, string>()
    for (const [name, value] of headers as Iterable<[string, string]>) {
      const existing = map.get(name)
      map.set(name, existing === undefined ? value : `${existing}, ${value}`)
    }
    return Object.fromEntries(map)
  }

  /**
   * Convert Headers to a plain object, keeping repeated values as arrays
   */
  private _headersToObject(headers: Headers): Record<string, string | string[]> {
    const map = new Map<string, string | string[]>()
    for (const [key, value] of headers) {
      const existing = map.get(key)
      if (existing === undefined) {
        map.set(key, value)
      } else if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        map.set(key, [existing, value])
      }
    }
    return Object.fromEntries(map)
  }
}
