/**
 * Stream-related exceptions for fetch-undici
 *
 * Handles errors related to response body streaming.
 */

import type { Request } from '../models/request.js'
import { HTTPError, type HTTPErrorOptions } from './base.js'

/**
 * Base class for stream errors
 */
export class StreamError extends HTTPError {
  constructor(message: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, options)
    this.name = 'StreamError'
  }
}

/**
 * Stream already consumed error
 *
 * Thrown when attempting to read a response body that has already been consumed.
 *
 * @example
 * ```typescript
 * const response = await client.get('/data')
 * const json = await response.json() // OK
 * const text = await response.text() // Throws StreamConsumedError
 * ```
 */
export class StreamConsumedError extends StreamError {
  constructor(request?: Request, options?: HTTPErrorOptions) {
    super('Response body has already been consumed', request, options)
    this.name = 'StreamConsumedError'
  }
}

/**
 * Stream closed error
 *
 * Thrown when attempting to read from a closed stream.
 */
export class StreamClosedError extends StreamError {
  constructor(request?: Request, options?: HTTPErrorOptions) {
    super('Stream has been closed', request, options)
    this.name = 'StreamClosedError'
  }
}

/**
 * Stream decode error
 *
 * Thrown when failing to decode stream data (e.g., invalid JSON).
 */
export class StreamDecodeError extends StreamError {
  readonly encoding?: string

  constructor(message: string, encoding?: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, options)
    this.name = 'StreamDecodeError'
    this.encoding = encoding
  }
}
