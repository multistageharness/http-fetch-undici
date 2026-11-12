/**
 * Query parameter handling for fetch-undici
 */

import { logger } from '../logger.js'
import type { QueryParams } from '../models/url.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Append params to a URLSearchParams
 *
 * Array values become repeated keys; null/undefined values (top-level or inside
 * arrays) are skipped.
 */
function appendParams(target: URLSearchParams, params: QueryParams): void {
  for (const [key, value] of Object.entries(params)) {
    const values: unknown[] = Array.isArray(value) ? value : [value]
    for (const v of values) {
      if (v !== undefined && v !== null) {
        target.append(key, String(v))
      }
    }
  }
}

/**
 * Merge query parameters with existing URL parameters
 */
export function mergeParams(
  existingParams: URLSearchParams,
  newParams?: QueryParams | null
): URLSearchParams {
  if (!newParams) {
    return existingParams
  }

  const result = new URLSearchParams(existingParams)

  appendParams(result, newParams)

  log.trace('Merged query parameters', {
    originalCount: existingParams.toString().split('&').filter(Boolean).length,
    newCount: Object.keys(newParams).length,
    resultCount: result.toString().split('&').filter(Boolean).length
  })

  return result
}

/**
 * Build URL with query parameters
 */
export function buildURLWithParams(
  baseURL: URL,
  params?: QueryParams | null
): URL {
  if (!params || Object.keys(params).length === 0) {
    return baseURL
  }

  const result = new URL(baseURL.toString())
  const mergedParams = mergeParams(result.searchParams, params)

  // Clear and re-add all params
  result.search = mergedParams.toString()

  return result
}

/**
 * Parse query string into params object
 */
export function parseQueryString(queryString: string): QueryParams {
  const params = new URLSearchParams(queryString)
  const result: QueryParams = {}

  for (const [key, value] of params.entries()) {
    const existing = result[key]
    if (existing !== undefined) {
      // Multiple values - convert to array
      if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        result[key] = [existing as string, value]
      }
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * Serialize params object to query string
 */
export function serializeParams(params: QueryParams): string {
  const searchParams = new URLSearchParams()

  appendParams(searchParams, params)

  return searchParams.toString()
}
