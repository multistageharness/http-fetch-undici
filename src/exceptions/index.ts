/**
 * Exception exports for fetch-undici
 *
 * Provides httpx-compatible exception hierarchy and error mapping utilities.
 */

import type { Request } from '../models/request.js'

// Re-export all exception classes
export {
  HTTPError,
  RequestError,
  InvalidURLError,
  RequestOptionsError,
  type HTTPErrorOptions
} from './base.js'

export {
  TransportError,
  TimeoutError,
  ConnectTimeoutError,
  ReadTimeoutError,
  WriteTimeoutError,
  PoolTimeoutError,
  NetworkError,
  ConnectError,
  SocketError,
  DNSError,
  TLSError,
  ProxyError
} from './transport.js'

export { HTTPStatusError, TooManyRedirectsError } from './status.js'

export { StreamError, StreamConsumedError, StreamClosedError, StreamDecodeError } from './stream.js'

// Import for internal use
import { HTTPError, RequestError, type HTTPErrorOptions } from './base.js'
import {
  TransportError,
  TimeoutError,
  ConnectTimeoutError,
  ReadTimeoutError,
  NetworkError,
  ConnectError,
  SocketError,
  DNSError,
  TLSError,
  ProxyError
} from './transport.js'
import { StreamError } from './stream.js'

/** Undici error codes that indicate an invalid request (caller bug, not transport failure) */
const REQUEST_ERROR_CODES = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_INVALID_RETURN_VALUE'])

/**
 * Map Undici errors to fetch-undici exception hierarchy
 *
 * Specific error classes are checked before the generic `UND_ERR_` prefix.
 * Every mapped error keeps the original error as `cause` and, when the source
 * error has a string `code`, exposes it as `code` on the mapped error.
 *
 * | Source                                         | Mapped to          |
 * | ---------------------------------------------- | ------------------ |
 * | `AbortError` (DOMException / undici abort)     | RequestError ('Request aborted') |
 * | `TimeoutError` DOMException (AbortSignal.timeout) | TimeoutError    |
 * | Headers/Body timeout                           | ReadTimeoutError   |
 * | Connect timeout                                | ConnectTimeoutError |
 * | `UND_ERR_INVALID_ARG`, `UND_ERR_INVALID_RETURN_VALUE` | RequestError |
 * | `UND_ERR_PRX_TLS` (SecureProxyConnectionError) | ProxyError         |
 * | `UND_ERR_RES_EXCEEDED_MAX_SIZE`                | StreamError        |
 * | other `UND_ERR*` (including base UndiciError)  | TransportError     |
 *
 * @param error - The original error from Undici
 * @param request - The request that caused the error (if available)
 * @returns Mapped fetch-undici exception
 */
export function mapUndiciError(error: unknown, request?: Request): HTTPError {
  if (error instanceof HTTPError) {
    return error
  }

  if (!(error instanceof Error)) {
    return new HTTPError(String(error), request)
  }

  const err = error as Error & {
    code?: unknown
    hostname?: string
    address?: unknown
    port?: unknown
  }
  // Some errors (e.g. DOMException) carry a numeric code; only strings are meaningful here
  const code = typeof err.code === 'string' ? err.code : undefined
  const message = err.message
  const options: HTTPErrorOptions = { cause: error, code }

  // Aborted requests (AbortController, undici RequestAbortedError / AbortError)
  if (err.name === 'AbortError' || code === 'UND_ERR_ABORTED' || code === 'UND_ERR_ABORT') {
    return new RequestError('Request aborted', request, options)
  }

  // AbortSignal.timeout() rejects with a DOMException named TimeoutError
  if (err.name === 'TimeoutError') {
    return new TimeoutError(message, undefined, request, options)
  }

  // Timeout errors
  if (
    err.name === 'HeadersTimeoutError' ||
    message.includes('Headers Timeout') ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return new ReadTimeoutError(undefined, request, options)
  }

  if (
    err.name === 'BodyTimeoutError' ||
    message.includes('Body Timeout') ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return new ReadTimeoutError(undefined, request, options)
  }

  if (
    err.name === 'ConnectTimeoutError' ||
    message.includes('Connect Timeout') ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return new ConnectTimeoutError(undefined, request, options)
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new TimeoutError(message, undefined, request, options)
  }

  // Invalid request (caller error) reported by undici
  if (code !== undefined && REQUEST_ERROR_CODES.has(code)) {
    return new RequestError(message, request, options)
  }

  // Connection errors
  if (code === 'ECONNREFUSED') {
    return new ConnectError(
      `Connection refused: ${message}`,
      typeof err.address === 'string' ? err.address : undefined,
      typeof err.port === 'number' ? err.port : undefined,
      code,
      request,
      options
    )
  }

  if (code === 'ECONNRESET') {
    return new SocketError(`Connection reset: ${message}`, code, request, options)
  }

  if (code === 'EPIPE' || code === 'ECONNABORTED') {
    return new SocketError(message, code, request, options)
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const hostname = err.hostname ?? 'unknown'
    return new DNSError(hostname, code, request, options)
  }

  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new NetworkError(`Host unreachable: ${message}`, code, request, options)
  }

  // TLS connection to the proxy itself failed
  if (code === 'UND_ERR_PRX_TLS') {
    return new ProxyError(message, undefined, request, options)
  }

  // TLS errors
  if (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    message.includes('certificate') ||
    message.includes('SSL') ||
    message.includes('TLS')
  ) {
    return new TLSError(message, request, options)
  }

  // Socket errors
  if (err.name === 'SocketError' || code?.startsWith('UND_ERR_SOCKET')) {
    return new SocketError(message, code, request, options)
  }

  // Response body exceeded the configured maximum size (not retryable)
  if (code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') {
    return new StreamError(message, request, options)
  }

  // Generic Undici errors (including the base UndiciError, code 'UND_ERR')
  if (code === 'UND_ERR' || code?.startsWith('UND_ERR_')) {
    return new TransportError(message, request, options)
  }

  // Request preparation errors
  if (err.name === 'TypeError' || err.name === 'InvalidArgumentError') {
    return new RequestError(message, request, options)
  }

  // Default to generic HTTPError
  return new HTTPError(message, request, options)
}

/**
 * Check if an error is a timeout error
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError
}

/**
 * Check if an error is a network error
 */
export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError
}

/**
 * Check if an error is a transport error
 */
export function isTransportError(error: unknown): error is TransportError {
  return error instanceof TransportError
}

/**
 * Check if an error is any HTTP error
 */
export function isHTTPError(error: unknown): error is HTTPError {
  return error instanceof HTTPError
}
