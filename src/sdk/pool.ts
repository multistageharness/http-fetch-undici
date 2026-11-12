/**
 * Pool Factory
 *
 * Generic singleton undici.Pool factory for any origin host.
 * Provides high-performance connection pooling and keep-alive.
 *
 * @example
 * ```typescript
 * import { getPool, PoolClient } from 'fetch-undici/sdk'
 *
 * // Get a singleton pool for any origin
 * const pool = getPool('https://api.example.com', {
 *   maxConnections: 100,
 *   keepAliveTimeout: 60000
 * })
 *
 * // Make requests
 * const response = await pool.post('/users', { name: 'John' })
 * const data = await pool.get('/users/123')
 *
 * // Clean up when done
 * await pool.close()
 * ```
 */

import { Pool, type Dispatcher } from 'undici'
import { logger } from '../logger.js'
import { Request, type HttpMethod } from '../models/request.js'
import { Response } from '../models/response.js'
import { HTTPStatusError } from '../exceptions/index.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Marker for requests without a body */
const NO_BODY = Symbol('no-body')

/** Pool client configuration */
export interface PoolConfig {
  /** Default headers to include in all requests */
  headers?: Record<string, string>
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number
  /** Maximum connections in pool (default: 100) */
  maxConnections?: number
  /** Keep-alive timeout in milliseconds (default: 60000) */
  keepAliveTimeout?: number
  /** Enable HTTP/2 (default: true) */
  http2?: boolean
  /** Pipelining factor (default: 1) */
  pipelining?: number
}

/** Request options for individual requests */
export interface RequestOptions {
  /** Request headers (merged with default headers) */
  headers?: Record<string, string>
  /** Request timeout in milliseconds (overrides pool default) */
  timeoutMs?: number
}

/**
 * Pool Client
 *
 * Provides a connection-pooled client for any origin using undici.Pool.
 */
export class PoolClient {
  private readonly _pool: Pool
  private readonly _originHost: string
  private readonly _defaultHeaders: Record<string, string>
  private readonly _timeoutMs: number
  private _closed = false

  constructor(originHost: string, config?: PoolConfig) {
    this._originHost = originHost.replace(/\/$/, '')
    this._defaultHeaders = config?.headers ?? {}

    const timeoutMs = config?.timeoutMs ?? 30000
    this._timeoutMs = timeoutMs

    this._pool = new Pool(this._originHost, {
      connections: config?.maxConnections ?? 100,
      keepAliveTimeout: config?.keepAliveTimeout ?? 60000,
      keepAliveMaxTimeout: config?.keepAliveTimeout ?? 60000,
      allowH2: config?.http2 ?? true,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      pipelining: config?.pipelining ?? 1
    })

    log.info('PoolClient created', {
      originHost: this._originHost,
      http2: config?.http2 ?? true,
      maxConnections: config?.maxConnections ?? 100
    })
  }

  /**
   * Get the origin host
   */
  get originHost(): string {
    return this._originHost
  }

  /**
   * Check if client is closed
   */
  get closed(): boolean {
    return this._closed
  }

  /**
   * Get the underlying undici Pool instance
   */
  get pool(): Pool {
    return this._pool
  }

  private _mergeHeaders(options?: RequestOptions): Record<string, string> {
    return {
      ...this._defaultHeaders,
      ...options?.headers
    }
  }

  private _getTimeout(options?: RequestOptions): number {
    return options?.timeoutMs ?? this._timeoutMs
  }

  /**
   * Send a JSON request and parse the JSON response
   *
   * - Throws {@link HTTPStatusError} (message `HTTP <status>: <body>`) for status >= 400
   * - Returns `undefined` for an empty body (e.g. 204 No Content)
   */
  private async _jsonRequest<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    options?: RequestOptions
  ): Promise<T> {
    if (this._closed) {
      throw new Error('Client has been closed')
    }

    const timeout = this._getTimeout(options)
    const hasBody = body !== NO_BODY
    const headers: Record<string, string> = {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      'Accept': 'application/json',
      ...this._mergeHeaders(options)
    }

    const response = await this._pool.request({
      path,
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      headersTimeout: timeout,
      bodyTimeout: timeout
    } as Dispatcher.RequestOptions)

    const text = await response.body.text()

    if (response.statusCode >= 400) {
      const request = new Request(method, this._originHost + path, { headers })
      const error = new HTTPStatusError(
        new Response({
          statusCode: response.statusCode,
          headers: response.headers as Record<string, string | string[]>,
          body: text,
          request
        }),
        request
      )
      error.message = `HTTP ${response.statusCode}: ${text}`
      throw error
    }

    return (text === '' ? undefined : JSON.parse(text)) as T
  }

  /**
   * Send a POST request with JSON body
   */
  async post<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this._jsonRequest<T>('POST', path, body, options)
  }

  /**
   * Send a GET request
   */
  async get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this._jsonRequest<T>('GET', path, NO_BODY, options)
  }

  /**
   * Send a PUT request with JSON body
   */
  async put<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this._jsonRequest<T>('PUT', path, body, options)
  }

  /**
   * Send a PATCH request with JSON body
   */
  async patch<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this._jsonRequest<T>('PATCH', path, body, options)
  }

  /**
   * Send a DELETE request
   */
  async delete<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this._jsonRequest<T>('DELETE', path, NO_BODY, options)
  }

  /**
   * Send a raw request using undici Pool directly
   */
  async request(options: Parameters<Pool['request']>[0]) {
    if (this._closed) {
      throw new Error('Client has been closed')
    }
    return this._pool.request(options)
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    if (this._closed) {
      return
    }

    this._closed = true
    // Drop from the singleton registry so it is no longer reported as active
    if (_poolSingletons.get(this._originHost) === this) {
      _poolSingletons.delete(this._originHost)
    }
    await this._pool.close()
    log.info('PoolClient closed', { originHost: this._originHost })
  }

  /**
   * Symbol.asyncDispose for `await using` syntax
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

// Singleton instance storage (keyed by origin)
const _poolSingletons = new Map<string, PoolClient>()

/**
 * Get or create a singleton pool client for an origin
 *
 * The config only applies when the pool is created; later calls for the same
 * origin return the existing pool and ignore (with a warning) any config.
 *
 * @param originHost - The origin (e.g., 'https://api.example.com')
 * @param config - Optional pool configuration
 * @returns The singleton PoolClient instance for this origin
 *
 * @example
 * ```typescript
 * // Basic usage
 * const api = getPool('https://api.example.com')
 * const data = await api.get('/users')
 *
 * // With configuration
 * const api = getPool('https://api.example.com', {
 *   headers: { 'Authorization': 'Bearer token' },
 *   maxConnections: 50,
 *   http2: true
 * })
 * ```
 */
export function getPool(originHost: string, config?: PoolConfig): PoolClient {
  const normalizedOrigin = originHost.replace(/\/$/, '')

  let client = _poolSingletons.get(normalizedOrigin)

  if (!client || client.closed) {
    client = new PoolClient(originHost, config)
    _poolSingletons.set(normalizedOrigin, client)
  } else if (config) {
    log.warn('getPool: pool already exists for origin; ignoring new config', {
      originHost: normalizedOrigin
    })
  }

  return client
}

/**
 * Close a singleton pool client for a specific origin
 */
export async function closePool(originHost: string): Promise<void> {
  const normalizedOrigin = originHost.replace(/\/$/, '')
  const client = _poolSingletons.get(normalizedOrigin)

  if (client) {
    await client.close()
    _poolSingletons.delete(normalizedOrigin)
  }
}

/**
 * Close all singleton pool clients
 */
export async function closeAllPools(): Promise<void> {
  const closePromises: Promise<void>[] = []

  for (const client of _poolSingletons.values()) {
    closePromises.push(client.close())
  }

  await Promise.all(closePromises)
  _poolSingletons.clear()
}

/**
 * Get all active pool origins (pools closed directly are removed from the registry)
 */
export function getActivePoolOrigins(): string[] {
  return Array.from(_poolSingletons.keys())
}
