/**
 * Cache Decorators and Higher-Order Functions
 *
 * Provides withCache HOF and @cached decorator for adding caching to functions.
 */

import type { Response } from '../../models/response.js'
import { logger } from '../../logger.js'
import { CacheManager } from '../core/cache-manager.js'
import { normalizeCacheUrl } from '../core/url.js'
import type { CacheConfig, RequestCacheOptions } from '../types.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Function signature for fetch-like functions
 */
export type FetchFunction = (
  method: string,
  url: string,
  options?: Record<string, unknown>
) => Promise<Response>

/**
 * Function signature for simplified fetch (GET-only)
 */
export type SimpleFetchFunction = (
  url: string,
  options?: Record<string, unknown>
) => Promise<Response>

/**
 * Options for the withCache HOF
 */
export interface WithCacheOptions extends CacheConfig {
  /** Extract cache options from request options */
  getCacheOptions?: (options?: Record<string, unknown>) => RequestCacheOptions | undefined
  /**
   * Base URL joined with relative URLs when building cache keys, so keys match
   * CachingClient's (e.g. 'GET:https://api.example.com/users'). It does not
   * change the URL passed to the wrapped function.
   */
  baseUrl?: string
}

/**
 * Options for the @cached decorator
 */
export interface CachedOptions extends CacheConfig {
  /**
   * Custom key from the method arguments (called with the instance as `this`).
   * Default: `<methodName>:<JSON args>`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: must accept keyFns with any concrete parameter types
  keyFn?: (...args: any[]) => string
}

/** Async method returning a Response */
// biome-ignore lint/suspicious/noExplicitAny: decorated methods have arbitrary receivers and parameters
type ResponseMethod = (this: any, ...args: any[]) => Promise<Response>

/**
 * Decorator returned by cached(); works as a TC39 (standard) method decorator
 * and as a legacy `experimentalDecorators` method decorator
 */
export interface CachedDecorator {
  <T extends ResponseMethod>(value: T, context: ClassMethodDecoratorContext): T
  <T extends ResponseMethod>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>
  ): TypedPropertyDescriptor<T>
  /** The cache manager shared by every method/instance using this decorator */
  readonly cache: CacheManager
}

/**
 * Higher-order function that adds caching to any fetch-like function
 *
 * @example
 * ```typescript
 * import { request } from 'fetch-undici'
 *
 * const cachedRequest = withCache(request, { ttl: 60000 })
 *
 * // First call - cache miss, fetches from network
 * const response1 = await cachedRequest('GET', 'https://api.example.com/users')
 *
 * // Second call - cache hit
 * const response2 = await cachedRequest('GET', 'https://api.example.com/users')
 * ```
 */
export function withCache(
  fetchFn: FetchFunction,
  config?: WithCacheOptions
): FetchFunction & { cache: CacheManager } {
  const cacheManager = new CacheManager(config)
  const _log = config?.logger ?? log

  const getCacheOpts =
    config?.getCacheOptions ?? ((opts) => opts?.cache as RequestCacheOptions | undefined)

  const cachedFetch: FetchFunction = async (
    method: string,
    url: string,
    options?: Record<string, unknown>
  ) => {
    const cacheOptions = getCacheOpts(options)

    // Check if caching is applicable
    if (!cacheManager.shouldCache(method, cacheOptions)) {
      return fetchFn(method, url, options)
    }

    const params = options?.params as Record<string, unknown> | undefined
    const cacheKey =
      cacheOptions?.cacheKey ??
      cacheManager.generateKey(
        method,
        normalizeCacheUrl(url, { baseUrl: config?.baseUrl, params: [params] }),
        options?.headers as Record<string, string>,
        options?.json ?? options?.data,
        params
      )

    const { response, status } = await cacheManager.fetchThrough(
      cacheKey,
      () => fetchFn(method, url, options),
      { ttl: cacheOptions?.ttl, forceRefresh: cacheOptions?.forceRefresh }
    )
    _log.debug(status === 'miss' ? 'Cache miss (withCache)' : 'Cache hit (withCache)', { key: cacheKey })
    return response
  }

  // Attach cache manager for manual operations
  ;(cachedFetch as FetchFunction & { cache: CacheManager }).cache = cacheManager

  return cachedFetch as FetchFunction & { cache: CacheManager }
}

/**
 * Higher-order function for simple GET functions
 *
 * @example
 * ```typescript
 * import { get } from 'fetch-undici'
 *
 * const cachedGet = withCacheSimple(get, { ttl: 60000 })
 * const response = await cachedGet('https://api.example.com/users')
 * ```
 */
export function withCacheSimple(
  fetchFn: SimpleFetchFunction,
  config?: WithCacheOptions
): SimpleFetchFunction & { cache: CacheManager } {
  const wrapped = withCache(
    (_method, url, options) => fetchFn(url, options),
    config
  )

  const simpleCachedFetch: SimpleFetchFunction = (url, options) => {
    return wrapped('GET', url, options)
  }

  ;(simpleCachedFetch as SimpleFetchFunction & { cache: CacheManager }).cache = wrapped.cache

  return simpleCachedFetch as SimpleFetchFunction & { cache: CacheManager }
}

/**
 * Decorator factory for caching method results
 *
 * Supports TC39 standard decorators (TypeScript 5+ default) and legacy
 * `experimentalDecorators`. Keys are scoped per instance, so two instances of
 * a class never share cached responses. The decorator exposes its
 * CacheManager as `.cache`.
 *
 * @example
 * ```typescript
 * class UserService {
 *   private client = new AsyncClient({ baseUrl: 'https://api.example.com' })
 *
 *   @cached({ ttl: 60000 })
 *   async getUsers(): Promise<Response> {
 *     return this.client.get('/users')
 *   }
 *
 *   @cached({ ttl: 30000, keyFn: (id) => `user:${id}` })
 *   async getUser(id: number): Promise<Response> {
 *     return this.client.get(`/users/${id}`)
 *   }
 * }
 * ```
 */
export function cached(config?: CachedOptions): CachedDecorator {
  const cacheManager = new CacheManager(config)
  const _log = config?.logger ?? log
  const keyFn = config?.keyFn

  /** Per-instance key prefix so instances do not share entries */
  const instanceIds = new WeakMap<object, number>()
  let nextInstanceId = 0
  const instancePrefix = (self: unknown): string => {
    if ((typeof self !== 'object' && typeof self !== 'function') || self === null) return ''
    let id = instanceIds.get(self)
    if (id === undefined) {
      id = ++nextInstanceId
      instanceIds.set(self, id)
    }
    return `@${id}:`
  }

  const wrap = (originalMethod: ResponseMethod, name: string): ResponseMethod =>
    async function (this: unknown, ...args: unknown[]): Promise<Response> {
      const baseKey = keyFn ? keyFn.apply(this, args) : `${name}:${JSON.stringify(args)}`
      const cacheKey = `${instancePrefix(this)}${baseKey}`

      const { response, status } = await cacheManager.fetchThrough(cacheKey, () =>
        originalMethod.apply(this, args)
      )
      _log.debug(status === 'miss' ? 'Cache miss (decorator)' : 'Cache hit (decorator)', {
        key: cacheKey
      })
      return response
    }

  function decorator(
    targetOrMethod: object,
    contextOrKey: ClassMethodDecoratorContext | string | symbol,
    descriptor?: TypedPropertyDescriptor<ResponseMethod>
  ): unknown {
    if (typeof contextOrKey === 'object') {
      // TC39 standard decorator: (value, context)
      if (contextOrKey.kind !== 'method') {
        throw new TypeError(`@cached can only decorate methods, not ${String(contextOrKey.kind)}`)
      }
      return wrap(targetOrMethod as ResponseMethod, String(contextOrKey.name))
    }

    // Legacy experimentalDecorators: (target, propertyKey, descriptor)
    const desc = descriptor!
    desc.value = wrap(desc.value!, String(contextOrKey))
    return desc
  }

  return Object.assign(decorator, { cache: cacheManager }) as unknown as CachedDecorator
}

/**
 * Create a cached version of any async function
 *
 * @example
 * ```typescript
 * async function fetchUser(id: number): Promise<Response> {
 *   return client.get(`/users/${id}`)
 * }
 *
 * const cachedFetchUser = createCachedFunction(fetchUser, {
 *   ttl: 60000,
 *   keyFn: (id) => `user:${id}`
 * })
 *
 * const response = await cachedFetchUser(123)
 * ```
 */
export function createCachedFunction<TArgs extends unknown[], TResult extends Response>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CacheConfig & {
    /** Custom key generation function (default: JSON.stringify(args)) */
    keyFn?: (...args: TArgs) => string
  }
): ((...args: TArgs) => Promise<TResult>) & { cache: CacheManager } {
  const cacheManager = new CacheManager(options)
  const _log = options?.logger ?? log
  const keyFn = options?.keyFn ?? ((...args: TArgs) => JSON.stringify(args))

  const cachedFn = async (...args: TArgs): Promise<TResult> => {
    const cacheKey = keyFn(...args)

    const { response, status } = await cacheManager.fetchThrough(cacheKey, () => fn(...args))
    _log.debug(status === 'miss' ? 'Cache miss (cachedFunction)' : 'Cache hit (cachedFunction)', {
      key: cacheKey
    })
    return response as TResult
  }

  ;(cachedFn as ((...args: TArgs) => Promise<TResult>) & { cache: CacheManager }).cache =
    cacheManager

  return cachedFn as ((...args: TArgs) => Promise<TResult>) & { cache: CacheManager }
}
