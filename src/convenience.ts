/**
 * Convenience functions for fetch-undici
 *
 * Provides standalone HTTP functions without needing to create a client.
 */

import { AsyncClient, type RequestOptions } from './client/index.js'
import type { Response } from './models/response.js'
import { logger } from './logger.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Shared default client (lazy initialized) */
let defaultClient: AsyncClient | null = null

/**
 * Close the default client when the event loop drains
 *
 * Registered once per process. Closing schedules more work, which makes Node
 * emit beforeExit again; the null check makes the re-fire a no-op.
 */
async function onBeforeExit(): Promise<void> {
  const client = defaultClient
  if (client) {
    defaultClient = null
    await client.close()
  }
}

/**
 * Get or create the default shared client
 */
function getDefaultClient(): AsyncClient {
  if (!defaultClient) {
    defaultClient = new AsyncClient({
      followRedirects: true,
      maxRedirects: 10
    })

    // Register cleanup on process exit (once, not per client)
    if (typeof process !== 'undefined' && !process.listeners('beforeExit').includes(onBeforeExit)) {
      process.on('beforeExit', onBeforeExit)
    }

    log.debug('Default client created')
  }

  return defaultClient
}

/**
 * Make GET request
 *
 * @example
 * ```typescript
 * import { get } from 'fetch-undici'
 *
 * const response = await get('https://api.example.com/users')
 * const data = await response.json()
 * ```
 */
export async function get(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().get(url, options)
}

/**
 * Make POST request
 *
 * @example
 * ```typescript
 * import { post } from 'fetch-undici'
 *
 * const response = await post('https://api.example.com/users', {
 *   json: { name: 'Alice' }
 * })
 * ```
 */
export async function post(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().post(url, options)
}

/**
 * Make PUT request
 */
export async function put(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().put(url, options)
}

/**
 * Make PATCH request
 */
export async function patch(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().patch(url, options)
}

/**
 * Make DELETE request
 *
 * Note: Named `del` to avoid conflict with JavaScript `delete` keyword
 */
export async function del(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().delete(url, options)
}

// Also export as 'delete' using property syntax
export { del as delete }

/**
 * Make HEAD request
 */
export async function head(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().head(url, options)
}

/**
 * Make OPTIONS request
 */
export async function options(url: string, options?: RequestOptions): Promise<Response> {
  return getDefaultClient().options(url, options)
}

/**
 * Make request with custom method
 */
export async function request(
  method: string,
  url: string,
  options?: RequestOptions
): Promise<Response> {
  return getDefaultClient().request(method, url, options)
}

/**
 * Close the default client
 *
 * Call this to release resources when done using convenience functions.
 */
export async function closeDefaultClient(): Promise<void> {
  const client = defaultClient
  if (client) {
    defaultClient = null
    await client.close()
    log.debug('Default client closed')
  }
}
