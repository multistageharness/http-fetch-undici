/**
 * Retry Module
 *
 * Industry-standard retry patterns:
 * - Capped exponential backoff with jitter
 * - Retry-After header support
 * - Idempotency-aware retry
 * - Circuit breaker pattern
 */

export {
  JitterStrategy,
  calculateDelay,
  parseRetryAfter,
  shouldRetryMethod,
  SAFE_METHODS,
  IDEMPOTENT_METHODS
} from './jitter.js'

export {
  CircuitState,
  CircuitBreaker,
  CircuitOpenError
} from './circuit-breaker.js'
export type { CircuitBreakerConfig } from './circuit-breaker.js'

export {
  DEFAULT_RETRY_CONFIG,
  normalizeRetryConfig,
  isRetryableError,
  RETRYABLE_ERROR_CODES
} from './config.js'
export type { RetryConfig } from './config.js'
