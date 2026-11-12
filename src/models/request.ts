/**
 * Request model for fetch-undici
 *
 * Represents an HTTP request with all its properties.
 */

import type { Readable } from 'node:stream'
import { logger } from '../logger.js'
import { type Headers, createHeaders, parseContentLength, type HeadersInit } from './headers.js'

const log = logger.create('fetch-undici', import.meta.url)

/** HTTP methods */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE'

/** Request body types */
export type RequestBody = string | Buffer | Uint8Array | Readable | FormData | URLSearchParams | null

/** Request options for cloning/modification */
export interface RequestOptions {
  method?: HttpMethod
  headers?: HeadersInit
  body?: RequestBody
  url?: string | URL
}

/**
 * HTTP Request class
 *
 * Immutable request object containing all request properties.
 *
 * @example
 * ```typescript
 * const request = new Request('GET', 'https://api.example.com/users', {
 *   headers: { 'Accept': 'application/json' }
 * })
 *
 * // Clone with modifications
 * const modified = request.clone({
 *   headers: { 'Authorization': 'Bearer token' }
 * })
 * ```
 */
export class Request {
  /** HTTP method */
  readonly method: HttpMethod

  /** Request URL */
  readonly url: URL

  /** Request headers */
  readonly headers: Headers

  /** Request body */
  readonly body: RequestBody

  /** Request creation timestamp */
  readonly timestamp: number

  constructor(method: HttpMethod, url: string | URL, options?: RequestOptions) {
    this.method = options?.method ?? method
    this.url = url instanceof URL ? url : new URL(url)
    this.headers = createHeaders(options?.headers)
    this.body = options?.body ?? null
    this.timestamp = Date.now()

    log.trace('Request created', {
      method: this.method,
      url: this.url.toString(),
      headerCount: this.headers.size,
      hasBody: this.body !== null
    })
  }

  /**
   * Get URL as string
   */
  get urlString(): string {
    return this.url.toString()
  }

  /**
   * Get URL origin
   */
  get origin(): string {
    return this.url.origin
  }

  /**
   * Get URL path
   */
  get path(): string {
    return this.url.pathname + this.url.search
  }

  /**
   * Check if request has body
   */
  get hasBody(): boolean {
    return this.body !== null
  }

  /**
   * Clone request with optional modifications
   */
  clone(options?: RequestOptions): Request {
    const newHeaders = this.headers.clone()

    // Merge additional headers: each name replaces the original's values,
    // while multiple values for the same name in the input are all kept
    if (options?.headers) {
      const additionalHeaders = createHeaders(options.headers)
      for (const name of additionalHeaders.keys()) {
        newHeaders.delete(name)
      }
      for (const [name, value] of additionalHeaders) {
        newHeaders.append(name, value)
      }
    }

    return new Request(options?.method ?? this.method, options?.url ?? this.url, {
      headers: newHeaders,
      body: options?.body !== undefined ? options.body : this.body
    })
  }

  /**
   * Convert to Undici request options
   */
  toUndiciOptions(): {
    method: string
    path: string
    headers: Record<string, string | string[]>
    body?: RequestBody
  } {
    const result: {
      method: string
      path: string
      headers: Record<string, string | string[]>
      body?: RequestBody
    } = {
      method: this.method,
      path: this.path,
      headers: this.headers.toUndiciHeaders()
    }

    if (this.body !== null) {
      result.body = this.body
    }

    return result
  }

  /**
   * Get content type from headers
   */
  get contentType(): string | null {
    return this.headers.get('content-type')
  }

  /**
   * Get content length from headers (null if missing or not a non-negative integer)
   */
  get contentLength(): number | null {
    return parseContentLength(this.headers.get('content-length'))
  }

  /**
   * String representation
   */
  toString(): string {
    return `Request(${this.method} ${this.url})`
  }
}

/**
 * Normalize HTTP method to uppercase
 */
export function normalizeMethod(method: string): HttpMethod {
  const upper = method.toUpperCase()
  const validMethods: HttpMethod[] = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
    'TRACE'
  ]
  if (validMethods.includes(upper as HttpMethod)) {
    return upper as HttpMethod
  }
  throw new Error(`Invalid HTTP method: ${method}`)
}
