/**
 * Cache URL normalisation
 *
 * Builds the URL used for cache keys so every cache entry point
 * (CachingClient, withCache, middleware) keys the same request identically.
 */

import { mergeParams } from '../../request/params.js'
import type { QueryParams } from '../../models/url.js'

/**
 * Options for normalizeCacheUrl
 */
export interface NormalizeCacheUrlOptions {
  /** Base URL joined with relative (non http/https) URLs */
  baseUrl?: string
  /** Query parameter sets appended in order (undefined/null sets are ignored) */
  params?: Array<Record<string, unknown> | null | undefined>
}

/**
 * Normalise a request URL for cache key generation
 *
 * - Joins relative URLs with `baseUrl` (absolute http/https URLs are kept)
 * - Drops the `#fragment`
 * - Merges query parameters already in the URL with each `params` set
 *   (arrays become repeated parameters; null/undefined values are skipped,
 *   matching how AsyncClient builds the request URL)
 * - Sorts parameters by name (stable for repeated names) so parameter order
 *   does not change the key
 *
 * @example
 * ```typescript
 * normalizeCacheUrl('/users?b=2', { baseUrl: 'https://api.example.com', params: [{ a: 1 }] })
 * // Returns: 'https://api.example.com/users?a=1&b=2'
 * ```
 */
export function normalizeCacheUrl(url: string, options?: NormalizeCacheUrlOptions): string {
  let full = url
  const baseUrl = options?.baseUrl
  if (baseUrl && !/^https?:\/\//i.test(url)) {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    full = `${base}${url.startsWith('/') ? url : `/${url}`}`
  }

  const hashIndex = full.indexOf('#')
  if (hashIndex !== -1) full = full.slice(0, hashIndex)

  const queryIndex = full.indexOf('?')
  const path = queryIndex === -1 ? full : full.slice(0, queryIndex)
  let search = new URLSearchParams(queryIndex === -1 ? '' : full.slice(queryIndex + 1))

  for (const params of options?.params ?? []) {
    search = mergeParams(search, params as QueryParams | null | undefined)
  }

  search.sort()
  const query = search.toString()
  return query ? `${path}?${query}` : path
}
