/**
 * Retry Configuration
 *
 * Industry-standard retry patterns:
 * - Capped exponential backoff with jitter
 * - Retry-After header support
 * - Idempotency-aware retry
 */

import { JitterStrategy } from './jitter.js'
import { TimeoutError, NetworkError } from '../exceptions/transport.js'

/**
 * Retry configuration options
 */
export interface RetryConfig {
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number
  /** Initial delay in milliseconds (default: 500) */
  retryDelay?: number
  /** Backoff multiplier (default: 2.0) */
  retryBackoff?: number
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxRetryDelay?: number
  /** Jitter strategy (default: FULL) */
  jitter?: JitterStrategy
  /** HTTP status codes to retry (default: [429, 500, 502, 503, 504]) */
  retryOnStatus?: number[]
  /** Retry on connection/timeout errors (default: true) */
  retryOnException?: boolean
  /** Honor Retry-After header (default: true) */
  respectRetryAfter?: boolean
  /** Methods to retry, undefined = idempotent only (default: undefined) */
  retryMethods?: string[]
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  retryDelay: 500, // 500ms base delay
  retryBackoff: 2.0,
  maxRetryDelay: 30000, // 30 seconds
  jitter: JitterStrategy.FULL,
  retryOnStatus: [429, 500, 502, 503, 504],
  retryOnException: true,
  respectRetryAfter: true,
  retryMethods: undefined as unknown as string[] // undefined means idempotent only
}

/**
 * Normalize retry configuration with defaults
 */
export function normalizeRetryConfig(
  config?: RetryConfig
): Required<RetryConfig> | null {
  if (!config) {
    return null
  }

  return {
    maxRetries: config.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    retryDelay: config.retryDelay ?? DEFAULT_RETRY_CONFIG.retryDelay,
    retryBackoff: config.retryBackoff ?? DEFAULT_RETRY_CONFIG.retryBackoff,
    maxRetryDelay: config.maxRetryDelay ?? DEFAULT_RETRY_CONFIG.maxRetryDelay,
    jitter: config.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
    retryOnStatus: config.retryOnStatus ?? DEFAULT_RETRY_CONFIG.retryOnStatus,
    retryOnException:
      config.retryOnException ?? DEFAULT_RETRY_CONFIG.retryOnException,
    respectRetryAfter:
      config.respectRetryAfter ?? DEFAULT_RETRY_CONFIG.respectRetryAfter,
    retryMethods: config.retryMethods ?? DEFAULT_RETRY_CONFIG.retryMethods
  }
}

/**
 * Retryable network error codes
 */
export const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
])

/**
 * Retryable library error class names
 *
 * Matched by name as well as instanceof so errors from another copy of the
 * library (or re-created errors without `.code`) are still recognized.
 */
export const RETRYABLE_ERROR_NAMES = new Set([
  'ConnectTimeoutError',
  'ReadTimeoutError',
  'WriteTimeoutError',
  'PoolTimeoutError',
  'NetworkError',
  'ConnectError',
  'SocketError',
  'DNSError'
])

/**
 * Check if an error is retryable
 *
 * Retryable when it is a library timeout/network error (by class or name),
 * or carries a retryable code, or mentions one in its message.
 */
export function isRetryableError(error: Error): boolean {
  if (error instanceof TimeoutError || error instanceof NetworkError) {
    return true
  }

  if (RETRYABLE_ERROR_NAMES.has(error.name)) {
    return true
  }

  const message = error.message || ''
  const code = (error as NodeJS.ErrnoException).code || ''

  // Check error code
  if (RETRYABLE_ERROR_CODES.has(code)) {
    return true
  }

  // Check error message for known patterns
  for (const errCode of RETRYABLE_ERROR_CODES) {
    if (message.includes(errCode)) {
      return true
    }
  }

  return false
}
