/**
 * Dispatcher factory for fetch-undici
 *
 * Creates and manages Undici dispatchers (Pool, Agent, etc).
 */

import { Pool, Agent, interceptors, type Dispatcher, type buildConnector } from 'undici'
import { logger } from '../logger.js'
import type { Timeout } from '../config/timeout.js'
import type { Limits } from '../config/limits.js'
import type { TLSConfig } from '../config/tls.js'
import { getOrigin } from '../models/url.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Connect options type */
export type ConnectOptions = buildConnector.BuildOptions

/** Dispatcher factory options */
export interface DispatcherOptions {
  timeout?: Timeout
  limits?: Limits
  tls?: TLSConfig
  http2?: boolean
  /** Allow HTTP/2 connections. Default: true */
  allowH2?: boolean
  /** Maximum response body size in bytes. -1 to disable */
  maxResponseSize?: number
  /** Custom connect options for socket creation */
  connect?: ConnectOptions
  /** Pipelining factor (1 = no pipelining) */
  pipelining?: number
  /**
   * Undici interceptors, applied with `dispatcher.compose()` outside the
   * redirect interceptor (they see each logical request once)
   */
  interceptors?: Dispatcher.DispatchInterceptor[]
  /** Follow redirects. Default: true */
  followRedirects?: boolean
  /** Maximum number of redirects. Default: 10 */
  maxRedirects?: number
}

/** Cached dispatcher entry */
interface CachedDispatcher {
  /** Dispatcher handed out (pool composed with interceptors) */
  dispatcher: Dispatcher
  /** Underlying pool (owns the connections) */
  pool: Pool
  origin: string
  createdAt: number
}

/**
 * Dispatcher factory for creating and caching Undici dispatchers
 *
 * Manages connection pools per origin for optimal performance.
 */
export class DispatcherFactory {
  private readonly _cache = new Map<string, CachedDispatcher>()
  private readonly _defaultOptions: DispatcherOptions
  private _defaultAgent: Agent | null = null
  private _rawAgent: Agent | null = null

  constructor(options?: DispatcherOptions) {
    this._defaultOptions = options ?? {}

    log.debug('DispatcherFactory created', {
      hasTimeout: !!options?.timeout,
      hasLimits: !!options?.limits,
      hasTls: !!options?.tls,
      http2: options?.http2
    })
  }

  /**
   * Get or create a dispatcher for the given URL
   */
  getDispatcher(url: string | URL): Dispatcher {
    return this._getEntry(getOrigin(url)).dispatcher
  }

  /**
   * Get default agent (for use with all origins)
   *
   * The returned agent is composed with the redirect and user interceptors;
   * it is still an `Agent` (undici's compose returns a proxy of it).
   */
  getDefaultAgent(): Agent {
    if (!this._defaultAgent) {
      const options = this._buildAgentOptions()
      log.trace('Creating agent', { options })

      const agent = new Agent(options)
      this._rawAgent = agent
      this._defaultAgent = this._compose(agent, this._buildInterceptors()) as Agent
      log.debug('Created default agent')
    }
    return this._defaultAgent
  }

  /**
   * Get or create the cache entry for an origin
   */
  private _getEntry(origin: string): CachedDispatcher {
    const cached = this._cache.get(origin)

    if (cached) {
      log.trace('Using cached dispatcher', { origin })
      return cached
    }

    const options = this._buildPoolOptions()
    log.trace('Creating pool', { origin, options: { ...options, connect: '[TLS options]' } })

    const pool = new Pool(origin, options)
    const entry: CachedDispatcher = {
      dispatcher: this._compose(pool, this._buildInterceptors(origin)),
      pool,
      origin,
      createdAt: Date.now()
    }
    this._cache.set(origin, entry)

    log.debug('Created new dispatcher', { origin })
    return entry
  }

  /**
   * Apply interceptors with undici 7 `compose()` (first = innermost)
   *
   * undici 7 ignores the `interceptors` constructor option, so this is the
   * only way interceptors take effect.
   */
  private _compose(
    dispatcher: Dispatcher,
    interceptors: Dispatcher.DispatcherComposeInterceptor[]
  ): Dispatcher {
    return interceptors.length > 0 ? dispatcher.compose(interceptors) : dispatcher
  }

  /**
   * Build the interceptor chain: redirect handling, then user interceptors
   *
   * @param origin - Pool origin. Pools can only reach their own origin, so
   *   cross-origin redirect hops are routed to the pool for the target origin.
   */
  private _buildInterceptors(origin?: string): Dispatcher.DispatcherComposeInterceptor[] {
    const chain: Dispatcher.DispatcherComposeInterceptor[] = []

    const followRedirects = this._defaultOptions.followRedirects ?? true
    if (followRedirects) {
      if (origin !== undefined) {
        chain.push(this._routeToOrigin(origin))
      }
      const maxRedirections = this._defaultOptions.maxRedirects ?? 10
      chain.push(interceptors.redirect({ maxRedirections }))
      if (origin !== undefined) {
        chain.push(this._defaultOrigin(origin))
      }
    }

    if (this._defaultOptions.interceptors) {
      chain.push(...this._defaultOptions.interceptors)
    }

    return chain
  }

  /**
   * Fill in `origin` for requests made directly on a pool
   *
   * The redirect interceptor resolves `Location` against `opts.origin`;
   * `pool.request({ path })` leaves it unset.
   */
  private _defaultOrigin(origin: string): Dispatcher.DispatcherComposeInterceptor {
    return (dispatch) => (opts, handler) =>
      dispatch(opts.origin === undefined ? { ...opts, origin } : opts, handler)
  }

  /**
   * Route requests for another origin to that origin's pool
   *
   * A Pool sends every request to its own origin, so without this a
   * cross-origin redirect would be fetched from the original host.
   */
  private _routeToOrigin(origin: string): Dispatcher.DispatcherComposeInterceptor {
    return (dispatch) => (opts, handler) => {
      const target = getOrigin(opts.origin!)
      if (target === origin) {
        return dispatch(opts, handler)
      }

      log.trace('Routing cross-origin request', { from: origin, to: target })
      return this._getEntry(target).pool.dispatch(opts, handler)
    }
  }

  /**
   * Build pool options from configuration
   */
  private _buildPoolOptions(): Pool.Options {
    const options: Pool.Options = {}

    // Timeout options
    if (this._defaultOptions.timeout) {
      const timeoutOpts = this._defaultOptions.timeout.toUndiciOptions()
      Object.assign(options, timeoutOpts)
    }

    // Limits options
    if (this._defaultOptions.limits) {
      const limitsOpts = this._defaultOptions.limits.toUndiciOptions()
      Object.assign(options, limitsOpts)
    }

    // TLS options - merge with custom connect options
    if (this._defaultOptions.tls || this._defaultOptions.connect) {
      const tlsOpts = this._defaultOptions.tls?.toUndiciOptions() ?? {}
      const connectOpts = this._defaultOptions.connect ?? {}
      options.connect = { ...connectOpts, ...tlsOpts }
    }

    // HTTP/2 - explicit allowH2 wins, then http2, else default true
    options.allowH2 = this._defaultOptions.allowH2 ?? this._defaultOptions.http2 ?? true

    // Maximum response size (-1 = disabled)
    if (
      this._defaultOptions.maxResponseSize !== undefined &&
      this._defaultOptions.maxResponseSize !== -1
    ) {
      options.maxResponseSize = this._defaultOptions.maxResponseSize
    }

    // Pipelining
    if (this._defaultOptions.pipelining !== undefined) {
      options.pipelining = this._defaultOptions.pipelining
    }

    return options
  }

  /**
   * Build agent options from configuration
   */
  private _buildAgentOptions(): Agent.Options {
    const options: Agent.Options = {}

    // Use pool factory for per-origin customization (interceptors are
    // composed once on the agent, not per pool)
    options.factory = (origin, opts) => {
      const poolOpts = { ...this._buildPoolOptions(), ...opts }
      return new Pool(origin, poolOpts)
    }

    // Limits for agent
    if (this._defaultOptions.limits) {
      options.connections = this._defaultOptions.limits.maxConnectionsPerHost ?? 10
    }

    return options
  }

  /**
   * Close all cached dispatchers
   */
  async closeAll(): Promise<void> {
    log.info('Closing all dispatchers', { count: this._cache.size })

    const closePromises: Promise<void>[] = []

    for (const { pool, origin } of this._cache.values()) {
      log.trace('Closing dispatcher', { origin })
      closePromises.push(pool.close())
    }

    if (this._rawAgent) {
      closePromises.push(this._rawAgent.close())
      this._rawAgent = null
      this._defaultAgent = null
    }

    await Promise.all(closePromises)
    this._cache.clear()

    log.debug('All dispatchers closed')
  }

  /**
   * Get cached dispatcher count
   */
  get cacheSize(): number {
    return this._cache.size
  }

  /**
   * Get all cached origins
   */
  get cachedOrigins(): string[] {
    return Array.from(this._cache.keys())
  }
}

/**
 * Create a simple pool for a single origin
 */
export function createPool(origin: string, options?: DispatcherOptions): Pool {
  const factory = new DispatcherFactory(options)
  return factory.getDispatcher(origin) as Pool
}

/**
 * Create an agent for multiple origins
 */
export function createAgent(options?: DispatcherOptions): Agent {
  const factory = new DispatcherFactory(options)
  return factory.getDefaultAgent()
}
