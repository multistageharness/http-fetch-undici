/**
 * Cache Middleware for Event Hooks
 *
 * Provides cache hooks that can be used with AsyncClient event hooks.
 *
 * Note: Due to the design of event hooks, they cannot short-circuit requests.
 * This middleware caches responses after they are received.
 */

import type { Request } from '../../models/request.js'
import type { Response } from '../../models/response.js'
import { logger } from '../../logger.js'
import { CacheManager } from '../core/cache-manager.js'
import { normalizeCacheUrl } from '../core/url.js'
import type { CacheConfig, RequestCacheOptions } from '../types.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Cache middleware options
 */
export interface CacheMiddlewareOptions extends CacheConfig {
  /**
   * Base URL joined with relative URLs when building cache keys
   * (createCacheAwareClient only; hooks always see absolute URLs)
   */
  baseUrl?: string
}

/**
 * Cache hooks for use with AsyncClient
 */
export interface CacheHooks {
  /** The cache manager instance */
  cacheManager: CacheManager

  /** Request hook - marks requests for potential caching */
  requestHook: (request: Request) => Promise<void>

  /** Response hook - caches successful responses */
  responseHook: (response: Response) => Promise<void>
}

/**
 * Create cache hooks for AsyncClient
 *
 * Note: Event hooks cannot short-circuit requests in fetch-undici.
 * This middleware tracks which requests should be cached and stores
 * successful responses. For full cache-before-fetch functionality,
 * use CachingClient instead.
 *
 * Keys use the same normalised URL as CachingClient/withCache (query
 * parameters sorted by name). Requests are tracked per Request object, so
 * concurrent requests to one URL and failed requests never leak or collide.
 * The response hook buffers the body; the response stays readable and
 * streamable for the caller.
 *
 * @example
 * ```typescript
 * const { cacheManager, requestHook, responseHook } = createCacheHooks({ ttl: 60000 })
 *
 * const client = new AsyncClient({
 *   baseUrl: 'https://api.example.com',
 *   eventHooks: {
 *     request: [requestHook],
 *     response: [responseHook]
 *   }
 * })
 *
 * // Responses are automatically cached
 * const response = await client.get('/users')
 *
 * // Manual cache operations
 * const cached = await cacheManager.get('GET:https://api.example.com/users')
 * await cacheManager.invalidate('GET:https://api.example.com/users')
 * ```
 */
export function createCacheHooks(options?: CacheMiddlewareOptions): CacheHooks {
  const cacheManager = new CacheManager(options)
  const _log = options?.logger ?? log

  /** Requests marked for caching (weak: entries vanish with failed requests) */
  const pendingCache = new WeakMap<Request, { key: string; method: string }>()

  const requestHook = async (request: Request): Promise<void> => {
    const method = request.method

    // Check if this method should be cached
    if (!cacheManager.shouldCache(method)) {
      return
    }

    // Generate cache key and mark for caching
    const cacheKey = cacheManager.generateKey(
      method,
      normalizeCacheUrl(request.urlString),
      request.headers
    )
    pendingCache.set(request, { key: cacheKey, method })

    _log.trace('Request marked for caching', { key: cacheKey })
  }

  const responseHook = async (response: Response): Promise<void> => {
    const request = response.request
    if (!request) return

    const pending = pendingCache.get(request)
    if (!pending) return

    pendingCache.delete(request)

    // Only cache successful responses
    if (response.ok) {
      await cacheManager.set(pending.key, response)
      _log.debug('Response cached', { key: pending.key })
    } else {
      _log.trace('Response not cached (non-2xx)', {
        key: pending.key,
        statusCode: response.statusCode
      })
    }
  }

  return {
    cacheManager,
    requestHook,
    responseHook
  }
}

/**
 * Create a cache-aware request function
 *
 * This provides a way to check the cache before making a request,
 * which event hooks cannot do. Keys match CachingClient's when `baseUrl`
 * is given (query parameters from the URL and `params` are included, sorted).
 * Per-request `cache` options (noCache, forceRefresh, ttl, cacheKey) are
 * honoured and stripped before calling the client.
 *
 * @example
 * ```typescript
 * const client = new AsyncClient({ baseUrl: 'https://api.example.com' })
 * const { cacheManager, makeRequest, get } = createCacheAwareClient(client, {
 *   ttl: 60000,
 *   baseUrl: 'https://api.example.com'
 * })
 *
 * // This will check cache first, then fetch if needed
 * const response = await makeRequest('GET', '/users')
 * await cacheManager.invalidate('GET:https://api.example.com/users')
 * ```
 */
export function createCacheAwareClient(
  client: { request: (method: string, url: string, options?: unknown) => Promise<Response> },
  options?: CacheMiddlewareOptions
) {
  const cacheManager = new CacheManager(options)
  const _log = options?.logger ?? log

  const makeRequest = async (
    method: string,
    url: string,
    requestOptions?: Record<string, unknown>
  ): Promise<Response> => {
    const cacheOptions = requestOptions?.['cache'] as RequestCacheOptions | undefined
    let clientOptions = requestOptions
    if (requestOptions && 'cache' in requestOptions) {
      const { cache: _cache, ...rest } = requestOptions
      clientOptions = rest
    }

    // Check if caching is applicable
    if (!cacheManager.shouldCache(method, cacheOptions)) {
      return client.request(method, url, clientOptions)
    }

    const params = requestOptions?.params as Record<string, unknown> | undefined
    const cacheKey =
      cacheOptions?.cacheKey ??
      cacheManager.generateKey(
        method,
        normalizeCacheUrl(url, { baseUrl: options?.baseUrl, params: [params] }),
        requestOptions?.headers as Record<string, string>,
        requestOptions?.json ?? requestOptions?.data,
        params
      )

    const { response, status } = await cacheManager.fetchThrough(
      cacheKey,
      () => client.request(method, url, clientOptions),
      { ttl: cacheOptions?.ttl, forceRefresh: cacheOptions?.forceRefresh }
    )
    _log.debug(status === 'miss' ? 'Cache miss' : 'Cache hit', { key: cacheKey })
    return response
  }

  return {
    cacheManager,
    makeRequest,

    // Convenience methods
    get: (url: string, options?: Record<string, unknown>) => makeRequest('GET', url, options),
    post: (url: string, options?: Record<string, unknown>) => makeRequest('POST', url, options),
    put: (url: string, options?: Record<string, unknown>) => makeRequest('PUT', url, options),
    patch: (url: string, options?: Record<string, unknown>) => makeRequest('PATCH', url, options),
    delete: (url: string, options?: Record<string, unknown>) => makeRequest('DELETE', url, options)
  }
}
