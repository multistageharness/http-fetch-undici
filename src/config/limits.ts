/**
 * Connection limits configuration for fetch-undici
 *
 * Provides httpx-compatible connection pool limits with Undici mapping.
 */

import { logger } from '../logger.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Limits options interface */
export interface LimitsOptions {
  /** Maximum total connections */
  maxConnections?: number | null
  /** Maximum connections per host/origin */
  maxConnectionsPerHost?: number | null
  /** Keep-alive timeout in milliseconds */
  keepAliveTimeout?: number
  /** Maximum keep-alive timeout in milliseconds */
  keepAliveMaxTimeout?: number
  /** Milliseconds subtracted from server keep-alive hints to account for latency. Default: 1000 */
  keepAliveTimeoutThreshold?: number
  /** Maximum concurrent streams for HTTP/2 connections */
  maxConcurrentStreams?: number
  /** Maximum header size in bytes */
  maxHeaderSize?: number
  /** Pipelining factor (1 = no pipelining). Default: 1 */
  pipelining?: number
}

/** Undici pool options */
export interface UndiciPoolOptions {
  connections?: number
  keepAliveTimeout?: number
  keepAliveMaxTimeout?: number
  keepAliveTimeoutThreshold?: number
  maxConcurrentStreams?: number
  maxHeaderSize?: number
  pipelining?: number
}

/** Default limit values */
const DEFAULT_MAX_CONNECTIONS = 100
const DEFAULT_MAX_CONNECTIONS_PER_HOST = 10
const DEFAULT_KEEP_ALIVE_TIMEOUT = 30000
const DEFAULT_KEEP_ALIVE_MAX_TIMEOUT = 600000
const DEFAULT_KEEP_ALIVE_TIMEOUT_THRESHOLD = 1000
const DEFAULT_PIPELINING = 1

/**
 * Validate a connection-count limit.
 *
 * - `undefined` -> `fallback`
 * - `null` or `Infinity` -> `null` (unlimited)
 * - negative or NaN -> RangeError
 */
function normalizeCount(name: string, value: number | null | undefined, fallback: number): number | null {
  if (value === undefined) {
    return fallback
  }
  if (value === null || value === Number.POSITIVE_INFINITY) {
    return null
  }
  return assertNonNegative(name, value)
}

/**
 * Validate a finite, non-negative number (throws RangeError otherwise).
 */
function assertNonNegative(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid limit "${name}": expected a finite non-negative number, got ${String(value)}`)
  }
  return value
}

/**
 * Validate an optional finite, non-negative number (undefined passes through).
 */
function optionalNonNegative(name: string, value: number | undefined): number | undefined {
  return value === undefined ? undefined : assertNonNegative(name, value)
}

/**
 * Connection limits configuration class
 *
 * Provides httpx-compatible limits configuration.
 *
 * @example
 * ```typescript
 * const limits = new Limits({
 *   maxConnections: 100,
 *   maxConnectionsPerHost: 10,
 *   keepAliveTimeout: 30000
 * })
 * ```
 *
 * Value semantics: omitted/undefined fields use the defaults. For
 * `maxConnections` / `maxConnectionsPerHost`, `null` (or `Infinity`) means
 * unlimited; `maxConnectionsPerHost: null` omits undici's `connections`
 * option, which undici treats as unlimited. Negative, NaN or (for the other
 * numeric fields) non-finite values throw a RangeError.
 */
export class Limits {
  /** Maximum total connections (null = unlimited) */
  readonly maxConnections: number | null

  /** Maximum connections per host/origin (null = unlimited) */
  readonly maxConnectionsPerHost: number | null

  /** Keep-alive timeout in milliseconds */
  readonly keepAliveTimeout: number

  /** Maximum keep-alive timeout in milliseconds */
  readonly keepAliveMaxTimeout: number

  /** Milliseconds subtracted from server keep-alive hints to account for latency */
  readonly keepAliveTimeoutThreshold: number

  /** Maximum concurrent streams for HTTP/2 connections */
  readonly maxConcurrentStreams?: number

  /** Maximum header size in bytes */
  readonly maxHeaderSize?: number

  /** Pipelining factor (1 = no pipelining) */
  readonly pipelining: number

  /**
   * Create a Limits instance
   *
   * @param options - LimitsOptions object
   */
  constructor(options?: LimitsOptions) {
    this.maxConnections = normalizeCount('maxConnections', options?.maxConnections, DEFAULT_MAX_CONNECTIONS)
    this.maxConnectionsPerHost = normalizeCount(
      'maxConnectionsPerHost',
      options?.maxConnectionsPerHost,
      DEFAULT_MAX_CONNECTIONS_PER_HOST
    )
    this.keepAliveTimeout = assertNonNegative(
      'keepAliveTimeout',
      options?.keepAliveTimeout ?? DEFAULT_KEEP_ALIVE_TIMEOUT
    )
    this.keepAliveMaxTimeout = assertNonNegative(
      'keepAliveMaxTimeout',
      options?.keepAliveMaxTimeout ?? DEFAULT_KEEP_ALIVE_MAX_TIMEOUT
    )
    this.keepAliveTimeoutThreshold = assertNonNegative(
      'keepAliveTimeoutThreshold',
      options?.keepAliveTimeoutThreshold ?? DEFAULT_KEEP_ALIVE_TIMEOUT_THRESHOLD
    )
    this.maxConcurrentStreams = optionalNonNegative('maxConcurrentStreams', options?.maxConcurrentStreams)
    this.maxHeaderSize = optionalNonNegative('maxHeaderSize', options?.maxHeaderSize)
    this.pipelining = assertNonNegative('pipelining', options?.pipelining ?? DEFAULT_PIPELINING)

    log.debug('Limits created', {
      maxConnections: this.maxConnections,
      maxConnectionsPerHost: this.maxConnectionsPerHost,
      keepAliveTimeout: this.keepAliveTimeout,
      keepAliveMaxTimeout: this.keepAliveMaxTimeout,
      keepAliveTimeoutThreshold: this.keepAliveTimeoutThreshold,
      maxConcurrentStreams: this.maxConcurrentStreams,
      maxHeaderSize: this.maxHeaderSize,
      pipelining: this.pipelining
    })
  }

  /**
   * Convert to Undici pool options
   */
  toUndiciOptions(): UndiciPoolOptions {
    const result: UndiciPoolOptions = {
      keepAliveTimeout: this.keepAliveTimeout,
      keepAliveMaxTimeout: this.keepAliveMaxTimeout,
      keepAliveTimeoutThreshold: this.keepAliveTimeoutThreshold,
      pipelining: this.pipelining
    }

    // Map connections per host to pool connections (omitted = unlimited in undici)
    if (this.maxConnectionsPerHost !== null) {
      result.connections = this.maxConnectionsPerHost
    }

    // HTTP/2 concurrent streams
    if (this.maxConcurrentStreams !== undefined) {
      result.maxConcurrentStreams = this.maxConcurrentStreams
    }

    // Max header size
    if (this.maxHeaderSize !== undefined) {
      result.maxHeaderSize = this.maxHeaderSize
    }

    log.trace('Converted to Undici options', { ...result })
    return result
  }

  /**
   * Create a new Limits with merged options
   */
  merge(options?: LimitsOptions): Limits {
    if (!options) {
      return this
    }

    return new Limits({
      maxConnections:
        options.maxConnections !== undefined ? options.maxConnections : this.maxConnections,
      maxConnectionsPerHost:
        options.maxConnectionsPerHost !== undefined
          ? options.maxConnectionsPerHost
          : this.maxConnectionsPerHost,
      keepAliveTimeout:
        options.keepAliveTimeout !== undefined ? options.keepAliveTimeout : this.keepAliveTimeout,
      keepAliveMaxTimeout:
        options.keepAliveMaxTimeout !== undefined
          ? options.keepAliveMaxTimeout
          : this.keepAliveMaxTimeout,
      keepAliveTimeoutThreshold:
        options.keepAliveTimeoutThreshold !== undefined
          ? options.keepAliveTimeoutThreshold
          : this.keepAliveTimeoutThreshold,
      maxConcurrentStreams:
        options.maxConcurrentStreams !== undefined
          ? options.maxConcurrentStreams
          : this.maxConcurrentStreams,
      maxHeaderSize:
        options.maxHeaderSize !== undefined ? options.maxHeaderSize : this.maxHeaderSize,
      pipelining: options.pipelining !== undefined ? options.pipelining : this.pipelining
    })
  }
}

/**
 * Create a Limits instance from various input types
 */
export function createLimits(input?: LimitsOptions | Limits): Limits {
  if (input instanceof Limits) {
    return input
  }
  return new Limits(input)
}
