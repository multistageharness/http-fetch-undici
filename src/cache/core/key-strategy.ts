/**
 * Cache Key Strategies
 *
 * Functions for generating cache keys from request data.
 */

import { createHash } from 'node:crypto'
import type { CacheKeyStrategy } from '../types.js'

/**
 * Default cache key strategy: METHOD:URL
 *
 * The built-in entry points (CachingClient, withCache, cache middleware) pass
 * a normalised URL that already contains the query string, merged from the URL
 * and `options.params` and sorted by parameter name.
 *
 * @example
 * ```typescript
 * defaultKeyStrategy('GET', 'https://api.example.com/users')
 * // Returns: 'GET:https://api.example.com/users'
 *
 * defaultKeyStrategy('GET', 'https://api.example.com/users?page=1')
 * // Returns: 'GET:https://api.example.com/users?page=1'
 * ```
 */
export const defaultKeyStrategy: CacheKeyStrategy = (method: string, url: string): string => {
  return `${method.toUpperCase()}:${url}`
}

/**
 * Get a value from an object using dot notation path
 *
 * @example
 * ```typescript
 * const obj = { headers: { Authorization: 'Bearer ****' } }
 * getByPath(obj, 'headers.Authorization') // 'Bearer ****'
 * ```
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

/**
 * Serialise a value for use in a cache key
 *
 * Strings are used verbatim; objects and arrays become JSON with object keys
 * sorted recursively so key order does not matter; other primitives use String().
 */
export function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return String(value)
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
}

/**
 * Create a cache key strategy using dot notation to access request properties
 *
 * Object/array values are serialised as JSON with sorted keys
 * (e.g. `body.filters={"a":1,"b":2}`).
 *
 * @example
 * ```typescript
 * const keyStrategy = createDotNotationKeyStrategy([
 *   'headers.Authorization',
 *   'headers.Accept-Language',
 *   'body.userId',
 *   'params.page'
 * ])
 *
 * // With request:
 * // { method: 'GET', url: '...', headers: { Authorization: 'Bearer xyz' }, params: { page: 1 } }
 * //
 * // Returns: 'GET:https://api.example.com/users:headers.Authorization=Bearer xyz:params.page=1'
 * ```
 */
export function createDotNotationKeyStrategy(paths: string[]): CacheKeyStrategy {
  return (
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: unknown,
    params?: Record<string, unknown>
  ): string => {
    const request: Record<string, unknown> = {
      method,
      url,
      headers: headers ?? {},
      body: body ?? {},
      params: params ?? {}
    }

    const parts = [method.toUpperCase(), url]

    for (const path of paths) {
      const value = getByPath(request, path)
      if (value !== undefined && value !== null) {
        parts.push(`${path}=${stableStringify(value)}`)
      }
    }

    return parts.join(':')
  }
}

/**
 * Default hash for createHashedKeyStrategy: SHA-256 hex truncated to 16 chars
 */
function sha256Hex16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * Create a cache key strategy that hashes all request data
 *
 * Useful when cache keys would be very long. The hash input is
 * `JSON.stringify({ method, url, headers, body, params })`.
 *
 * @param hashFn - Hash function (default: SHA-256 hex truncated to 16 chars)
 *
 * @example
 * ```typescript
 * // Default SHA-256 (16 hex chars)
 * const keyStrategy = createHashedKeyStrategy()
 *
 * // Custom hash
 * import { createHash } from 'node:crypto'
 * const md5Strategy = createHashedKeyStrategy((data) =>
 *   createHash('md5').update(data).digest('hex')
 * )
 * ```
 */
export function createHashedKeyStrategy(
  hashFn: (input: string) => string = sha256Hex16
): CacheKeyStrategy {
  return (
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: unknown,
    params?: Record<string, unknown>
  ): string => {
    const data = JSON.stringify({ method, url, headers, body, params })
    return hashFn(data)
  }
}

/**
 * Combine multiple key strategies
 *
 * Outputs are joined with `:`. Empty and duplicate outputs are dropped, and when
 * an output extends the key built so far (starts with `<key so far>:`) only the
 * extension is appended, so a shared `METHOD:URL` prefix is not repeated.
 *
 * @example
 * ```typescript
 * const keyStrategy = combineKeyStrategies(
 *   defaultKeyStrategy,
 *   createDotNotationKeyStrategy(['headers.Authorization'])
 * )
 * keyStrategy('GET', 'https://api.example.com/users', { Authorization: 'Bearer t' })
 * // Returns: 'GET:https://api.example.com/users:headers.Authorization=Bearer t'
 * ```
 */
export function combineKeyStrategies(...strategies: CacheKeyStrategy[]): CacheKeyStrategy {
  return (
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: unknown,
    params?: Record<string, unknown>
  ): string => {
    const parts: string[] = []
    let combined = ''

    for (const strategy of strategies) {
      const key = strategy(method, url, headers, body, params)
      if (!key || parts.includes(key)) continue

      parts.push(key)
      if (combined && key.startsWith(`${combined}:`)) {
        combined = key
      } else {
        combined = combined ? `${combined}:${key}` : key
      }
    }

    return combined
  }
}
