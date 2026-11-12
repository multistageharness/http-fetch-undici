/**
 * Jitter Strategies for Retry Backoff
 *
 * Implements industry-standard jitter patterns to prevent
 * synchronized retry storms ("thundering herd").
 */

/**
 * Jitter strategy for retry backoff
 */
export enum JitterStrategy {
  /** No jitter: delay = base * (backoff ^ attempt) */
  NONE = 'none',
  /** Full jitter: delay = random(0, calculated_delay) */
  FULL = 'full',
  /** Equal jitter: delay = calculated_delay/2 + random(0, calculated_delay/2) */
  EQUAL = 'equal',
  /** Decorrelated jitter: delay = random(base, previous_delay * 3) */
  DECORRELATED = 'decorrelated'
}

/**
 * Calculate retry delay with jitter
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds
 * @param backoff - Backoff multiplier
 * @param maxDelay - Maximum delay cap in milliseconds
 * @param jitter - Jitter strategy to apply
 * @param lastDelay - Last delay used (for decorrelated jitter)
 * @returns Delay in milliseconds with jitter applied
 */
export function calculateDelay(
  attempt: number,
  baseDelay: number,
  backoff: number,
  maxDelay: number,
  jitter: JitterStrategy,
  lastDelay?: number
): number {
  // Calculate exponential delay
  const calculated = baseDelay * backoff ** attempt

  // Apply cap
  const capped = Math.min(calculated, maxDelay)

  // Apply jitter strategy
  switch (jitter) {
    case JitterStrategy.NONE:
      return capped

    case JitterStrategy.FULL:
      // Full jitter: random between 0 and calculated delay
      return Math.random() * capped

    case JitterStrategy.EQUAL:
      // Equal jitter: half fixed + half random
      return capped / 2 + Math.random() * (capped / 2)

    case JitterStrategy.DECORRELATED: {
      // Decorrelated jitter: based on previous delay
      const prevDelay = lastDelay ?? baseDelay
      const decorrelated = baseDelay + Math.random() * (prevDelay * 3 - baseDelay)
      return Math.min(decorrelated, maxDelay)
    }

    default:
      return capped
  }
}

/**
 * HTTP-date formats (RFC 9110 Section 5.6.7):
 * - IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`
 * - RFC 850:     `Sunday, 06-Nov-94 08:49:37 GMT`
 * - asctime:     `Sun Nov  6 08:49:37 1994`
 */
const HTTP_DATE_RE =
  /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/

/**
 * Parse Retry-After header value
 *
 * Supports both formats (RFC 9110 Section 10.2.3):
 * - delay-seconds (non-negative integer): "Retry-After: 120"
 * - HTTP-date: "Retry-After: Wed, 21 Oct 2024 07:28:00 GMT"
 *
 * Anything else (negative, fractional, trailing garbage) is rejected.
 *
 * @param value - Retry-After header value
 * @returns Delay in milliseconds, or null if not parseable
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null

  const trimmed = value.trim()

  // delay-seconds: a non-negative integer (RFC 9110 Section 10.2.3)
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000 // Convert to ms
  }

  // HTTP-date (IMF-fixdate, obsolete RFC 850 or asctime format)
  if (!HTTP_DATE_RE.test(trimmed)) {
    return null
  }

  // asctime carries no zone but is defined as GMT
  const date = new Date(trimmed.endsWith('GMT') ? trimmed : `${trimmed} GMT`)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return Math.max(0, date.getTime() - Date.now())
}

// HTTP methods considered safe/idempotent for retry
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])
export const IDEMPOTENT_METHODS = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'PUT',
  'DELETE'
])

/**
 * Check if a method should be retried based on idempotency
 *
 * @param method - HTTP method
 * @param headers - Request headers (check for Idempotency-Key)
 * @param allowedMethods - Explicit list of methods to retry (overrides default)
 * @returns true if method is safe to retry
 */
export function shouldRetryMethod(
  method: string,
  headers?: HeadersLike,
  allowedMethods?: string[]
): boolean {
  const methodUpper = method.toUpperCase()

  // If explicit methods configured, use that
  if (allowedMethods) {
    return allowedMethods.map((m) => m.toUpperCase()).includes(methodUpper)
  }

  // Default: retry idempotent methods
  if (IDEMPOTENT_METHODS.has(methodUpper)) {
    return true
  }

  // POST/PATCH with Idempotency-Key header is safe to retry
  return headers ? hasIdempotencyKey(headers) : false
}

/** Header containers accepted by shouldRetryMethod */
export type HeadersLike =
  | Record<string, string | string[] | undefined>
  | Map<string, string>
  | Array<[string, string]>
  | { get(name: string): string | null }

/** Lowercase names of headers that mark a request as idempotent */
const IDEMPOTENCY_HEADERS = ['idempotency-key', 'x-idempotency-key']

/**
 * Check for a non-empty Idempotency-Key / X-Idempotency-Key header
 *
 * Header names are matched case-insensitively.
 */
function hasIdempotencyKey(headers: HeadersLike): boolean {
  let entries: Iterable<[string, unknown]>

  if (headers instanceof Map || Array.isArray(headers)) {
    entries = headers
  } else if (typeof headers.get === 'function') {
    // Headers-like objects (fetch Headers, library Headers) look up case-insensitively
    const h = headers as { get(name: string): string | null }
    return !!(h.get('Idempotency-Key') || h.get('X-Idempotency-Key'))
  } else {
    entries = Object.entries(headers)
  }

  for (const [name, value] of entries) {
    if (value && IDEMPOTENCY_HEADERS.includes(String(name).toLowerCase())) {
      return true
    }
  }

  return false
}
