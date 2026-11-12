/**
 * AsyncClient for fetch-undici
 *
 * Main HTTP client class providing httpx-compatible API.
 * Includes industry-standard retry patterns and circuit breaker.
 */

import { request as undiciRequest, ProxyAgent, interceptors as undiciInterceptors, type Dispatcher } from 'undici'
import { PassThrough, Readable } from 'node:stream'
import { logger, type Logger } from '../logger.js'
import { Request, normalizeMethod, type HttpMethod } from '../models/request.js'
import { Response } from '../models/response.js'
import { type Headers, createHeaders } from '../models/headers.js'
import { buildURL, type QueryParams } from '../models/url.js'
import { createTimeout, type Timeout } from '../config/timeout.js'
import { createLimits, type Limits } from '../config/limits.js'
import { createTLSConfig, type TLSConfig } from '../config/tls.js'
import { DispatcherFactory, type DispatcherOptions } from '../transport/dispatcher.js'
import { type MountRouter, createMountRouter } from '../transport/router.js'
import { processBody, hasBodyOptions } from '../request/body.js'
import { buildURLWithParams } from '../request/params.js'
import {
  mapUndiciError,
  TransportError,
  TooManyRedirectsError
} from '../exceptions/index.js'
// biome-ignore lint/suspicious/noShadowRestrictedNames: library's exported Proxy config class
import { createProxy, getEnvProxy, type Proxy } from '../config/proxy.js'
import type { Auth } from '../auth/base.js'
import {
  type AsyncClientOptions,
  type RequestOptions,
  type EventHooks,
  normalizeClientOptions,
  normalizeRequestOptions
} from './options.js'
import {
  type RetryConfig,
  DEFAULT_RETRY_CONFIG,
  normalizeRetryConfig,
  isRetryableError,
  calculateDelay,
  parseRetryAfter,
  shouldRetryMethod,
  CircuitBreaker,
  CircuitOpenError
} from '../retry/index.js'

const defaultLog = logger.create('fetch-undici', import.meta.url)

/**
 * AsyncClient - Main HTTP client
 *
 * Provides httpx-compatible HTTP client functionality using Undici.
 *
 * @example
 * ```typescript
 * const client = new AsyncClient({
 *   baseUrl: 'https://api.example.com',
 *   auth: new BasicAuth('user', 'pass'),
 *   timeout: { connect: 5000, read: 30000 }
 * })
 *
 * const response = await client.get('/users')
 * const data = await response.json()
 *
 * await client.close()
 * ```
 */
export class AsyncClient {
  private readonly _baseUrl?: URL
  private readonly _defaultHeaders: Headers
  private readonly _defaultParams?: QueryParams
  private readonly _auth?: Auth
  private readonly _timeout: Timeout
  private readonly _limits: Limits
  private readonly _tls?: TLSConfig
  private readonly _http2: boolean
  private readonly _allowH2: boolean
  private readonly _maxResponseSize: number
  private readonly _pipelining: number
  private readonly _followRedirects: boolean
  private readonly _maxRedirects: number
  private readonly _eventHooks: EventHooks
  private readonly _dispatcherOptions: DispatcherOptions
  protected readonly _dispatcherFactory: DispatcherFactory
  protected readonly _mountRouter: MountRouter
  protected readonly _log: Logger

  /** Proxy dispatchers created by this client, with the Proxy they serve (for NO_PROXY) */
  private readonly _proxyDispatchers = new Map<Dispatcher, Proxy>()
  /** Lazily created factory with redirects enabled (per-request followRedirects: true) */
  private _redirectFactory: DispatcherFactory | null = null
  /** Mounted dispatchers composed with a redirect interceptor (per-request override) */
  private readonly _redirectMounts = new WeakMap<Dispatcher, Dispatcher>()

  // Retry configuration
  private readonly _retry: Required<RetryConfig> | null
  private readonly _circuitBreaker: CircuitBreaker | null
  /** Statuses counted as circuit breaker failures */
  private readonly _failureStatuses: number[]

  protected _closed = false

  constructor(options?: AsyncClientOptions) {
    const opts = normalizeClientOptions(options)

    // Logger
    this._log = opts.logger ?? defaultLog

    // Base URL
    if (opts.baseUrl) {
      this._baseUrl = new URL(opts.baseUrl)
      this._log.debug('Base URL set', { baseUrl: this._baseUrl.toString() })
    }

    // Headers (createHeaders copies its input)
    this._defaultHeaders = createHeaders(opts.headers)

    // Params
    this._defaultParams = opts.params

    // Auth
    this._auth = opts.auth

    // Timeout
    this._timeout = createTimeout(opts.timeout)

    // Limits
    this._limits = createLimits(opts.limits)

    // TLS (`tls: false` means "don't verify", so test for presence, not truthiness)
    if (opts.tls !== undefined && opts.tls !== null) {
      this._tls = createTLSConfig(opts.tls)
    }

    // HTTP/2
    this._http2 = opts.http2 ?? false
    this._allowH2 = opts.allowH2 ?? true
    this._maxResponseSize = opts.maxResponseSize ?? -1
    this._pipelining = opts.pipelining ?? 1

    // Redirects
    this._followRedirects = opts.followRedirects ?? true
    this._maxRedirects = opts.maxRedirects ?? 10

    // Event hooks
    this._eventHooks = opts.eventHooks ?? {}

    // Dispatcher factory
    this._dispatcherOptions = {
      timeout: this._timeout,
      limits: this._limits,
      tls: this._tls,
      http2: this._http2,
      allowH2: this._allowH2,
      maxResponseSize: this._maxResponseSize,
      connect: opts.connect,
      pipelining: this._pipelining,
      interceptors: opts.interceptors,
      followRedirects: this._followRedirects,
      maxRedirects: this._maxRedirects
    }
    this._dispatcherFactory = new DispatcherFactory(this._dispatcherOptions)

    // Mount router
    this._mountRouter = createMountRouter(opts.mounts)

    // Proxy — create ProxyAgent and mount on router for http:// and https://
    const tlsOpts = this._tls ? this._tls.toUndiciOptions() as Record<string, unknown> : undefined
    const proxy = createProxy(opts.proxy)
    if (proxy) {
      const proxyAgent = this._createProxyDispatcher(proxy, tlsOpts, opts.interceptors)
      this._mountRouter.mount('https://', proxyAgent)
      this._mountRouter.mount('http://', proxyAgent)
      this._log.info('Proxy mounted on router', { url: proxy.sanitizedUrl })
    } else if (opts.trustEnv) {
      const envProxy = getEnvProxy()
      if (envProxy.https) {
        const httpsAgent = this._createProxyDispatcher(envProxy.https, tlsOpts, opts.interceptors)
        this._mountRouter.mount('https://', httpsAgent)
        this._log.info('Environment HTTPS proxy mounted', { url: envProxy.https.sanitizedUrl })
      }
      if (envProxy.http) {
        const httpAgent = this._createProxyDispatcher(envProxy.http, tlsOpts, opts.interceptors)
        this._mountRouter.mount('http://', httpAgent)
        this._log.info('Environment HTTP proxy mounted', { url: envProxy.http.sanitizedUrl })
      }
    }

    // Retry configuration
    this._retry = normalizeRetryConfig(opts.retry)

    // Circuit breaker
    this._circuitBreaker = opts.circuitBreaker ? new CircuitBreaker(opts.circuitBreaker) : null
    this._failureStatuses = this._retry?.retryOnStatus ?? DEFAULT_RETRY_CONFIG.retryOnStatus

    this._log.info('AsyncClient created', {
      hasBaseUrl: !!this._baseUrl,
      hasAuth: !!this._auth,
      http2: this._http2,
      allowH2: this._allowH2,
      maxResponseSize: this._maxResponseSize,
      pipelining: this._pipelining,
      followRedirects: this._followRedirects,
      retryEnabled: !!this._retry,
      circuitBreakerEnabled: !!this._circuitBreaker
    })
  }

  /**
   * Get circuit breaker instance
   */
  get circuitBreaker(): CircuitBreaker | null {
    return this._circuitBreaker
  }

  // ============================================================================
  // HTTP Methods
  // ============================================================================

  /**
   * Make HTTP request
   *
   * When a circuit breaker is configured it is consulted before every request
   * (with or without retry), and every attempt records its outcome: transport
   * errors and failure statuses (`retry.retryOnStatus`, default
   * 429/500/502/503/504) count as failures, any other completed response as a
   * success.
   */
  async request(method: string, url: string, options?: RequestOptions): Promise<Response> {
    this._ensureNotClosed()

    const httpMethod = normalizeMethod(method)
    const opts = normalizeRequestOptions(options)

    if (this._circuitBreaker && !this._circuitBreaker.allowRequest()) {
      throw new CircuitOpenError(`Circuit breaker is open, request to ${url} blocked`)
    }

    // If no retry config, execute directly
    if (!this._retry) {
      return this._executeAttempt(httpMethod, url, opts)
    }

    // Execute with retry logic
    return this._executeWithRetry(httpMethod, url, opts)
  }

  /**
   * Execute one attempt and record its outcome on the circuit breaker
   */
  private async _executeAttempt(
    method: HttpMethod,
    url: string,
    options: RequestOptions
  ): Promise<Response> {
    let response: Response
    try {
      response = await this._executeRequest(method, url, options)
    } catch (err) {
      if (this._circuitBreaker && err instanceof TransportError) {
        this._circuitBreaker.recordFailure()
      }
      throw err
    }

    if (this._circuitBreaker) {
      if (this._failureStatuses.includes(response.statusCode)) {
        this._circuitBreaker.recordFailure()
      } else {
        this._circuitBreaker.recordSuccess()
      }
    }

    return response
  }

  /**
   * Execute request with retry logic
   */
  private async _executeWithRetry(
    method: HttpMethod,
    url: string,
    options: RequestOptions
  ): Promise<Response> {
    const retry = this._retry!

    // Check if method is safe to retry (Idempotency-Key may come from default headers)
    const canRetry = shouldRetryMethod(
      method,
      this._buildHeaders(options.headers),
      retry.retryMethods
    )

    // Per-request state: concurrent requests must not share jitter history
    let lastDelay = retry.retryDelay

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this._executeAttempt(method, url, options)
      } catch (err) {
        const error = err as Error
        const isRetryable =
          retry.retryOnException && isRetryableError(error) && canRetry

        if (!isRetryable || attempt >= retry.maxRetries) {
          this._log.warn('Not retrying failed request', {
            method,
            error: error.message,
            retryable: isRetryable
          })
          throw error
        }

        const delay = calculateDelay(
          attempt,
          retry.retryDelay,
          retry.retryBackoff,
          retry.maxRetryDelay,
          retry.jitter,
          lastDelay
        )

        this._log.warn('Request failed, retrying', {
          error: error.message,
          attempt: attempt + 1,
          delay: Math.round(delay),
          method
        })

        lastDelay = delay
        await this._delay(delay)
        continue
      }

      // Check if we should retry based on status
      const shouldRetryStatus =
        retry.retryOnStatus.includes(response.statusCode) &&
        attempt < retry.maxRetries &&
        canRetry

      if (!shouldRetryStatus) {
        return response
      }

      let delay = calculateDelay(
        attempt,
        retry.retryDelay,
        retry.retryBackoff,
        retry.maxRetryDelay,
        retry.jitter,
        lastDelay
      )

      // Check Retry-After header
      if (retry.respectRetryAfter) {
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
        if (retryAfter !== null) {
          delay = Math.min(retryAfter, retry.maxRetryDelay)
          this._log.info('Using Retry-After header', {
            retryAfter,
            cappedTo: delay
          })
        }
      }

      this._log.warn('Retrying request', {
        statusCode: response.statusCode,
        attempt: attempt + 1,
        delay: Math.round(delay),
        method,
        url
      })

      // Release the discarded response's connection
      await response.aclose()

      lastDelay = delay
      await this._delay(delay)
    }
  }

  /**
   * Delay helper
   */
  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * GET request
   */
  async get(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('GET', url, options)
  }

  /**
   * POST request
   */
  async post(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('POST', url, options)
  }

  /**
   * PUT request
   */
  async put(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('PUT', url, options)
  }

  /**
   * PATCH request
   */
  async patch(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('PATCH', url, options)
  }

  /**
   * DELETE request
   */
  async delete(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('DELETE', url, options)
  }

  /**
   * HEAD request
   */
  async head(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('HEAD', url, options)
  }

  /**
   * OPTIONS request
   */
  async options(url: string, options?: RequestOptions): Promise<Response> {
    return this.request('OPTIONS', url, options)
  }

  // ============================================================================
  // Streaming
  // ============================================================================

  /**
   * Stream response body
   */
  async *stream(
    method: string,
    url: string,
    options?: RequestOptions
  ): AsyncGenerator<Buffer> {
    const response = await this.request(method, url, options)

    for await (const chunk of response.aiterBytes()) {
      yield chunk
    }
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Close client and release resources
   */
  async close(): Promise<void> {
    if (this._closed) {
      return
    }

    this._log.info('Closing AsyncClient')

    this._closed = true
    await this._dispatcherFactory.closeAll()
    if (this._redirectFactory) {
      await this._redirectFactory.closeAll()
    }
    await this._mountRouter.closeAll()

    this._log.debug('AsyncClient closed')
  }

  /**
   * Symbol.asyncDispose for `await using` syntax
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  /**
   * Check if client is closed
   */
  get closed(): boolean {
    return this._closed
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Execute HTTP request (one attempt, including an auth challenge round trip)
   */
  private async _executeRequest(
    method: HttpMethod,
    url: string,
    options: RequestOptions
  ): Promise<Response> {
    // Build URL (throws InvalidURLError for e.g. a relative URL without baseUrl)
    const fullUrl = this._buildUrl(url, options.params)

    this._log.debug('Request starting', {
      method,
      url: fullUrl.toString()
    })

    // Build headers
    const headers = this._buildHeaders(options.headers)

    // Process body
    let body: string | Buffer | Readable | FormData | null = null
    if (hasBodyOptions(options)) {
      const processed = processBody(options, headers)
      body = processed.body

      // Merge processed headers (Content-Type)
      for (const [name, value] of processed.headers) {
        if (!headers.has(name)) {
          headers.set(name, value)
        }
      }
    }

    // Create request object
    const baseRequest = new Request(method, fullUrl, {
      headers,
      body
    })

    // Apply auth
    const auth = options.auth !== undefined ? options.auth : this._auth
    let request = auth ? await this._applyAuth(auth, baseRequest) : baseRequest

    // Call request hooks (errors propagate unchanged)
    await this._callRequestHooks(request)

    let response = await this._send(request, fullUrl, options)

    // Challenge-response auth (e.g. Digest): answer one 401 challenge
    if (
      auth &&
      response.statusCode === 401 &&
      auth.canHandleChallenge(response) &&
      !(body instanceof Readable)
    ) {
      this._log.debug('Answering auth challenge')
      await response.aclose()
      request = auth.apply(baseRequest, response)
      await this._callRequestHooks(request)
      response = await this._send(request, fullUrl, options)
    }

    // Call response hooks; close the body if one throws
    try {
      await this._callResponseHooks(response)
    } catch (err) {
      await response.aclose()
      throw err
    }

    return response
  }

  /**
   * Apply auth, preferring an async implementation when the auth provides one
   */
  private async _applyAuth(auth: Auth, request: Request): Promise<Request> {
    const applyAsync = (auth as Auth & { applyAsync?: (r: Request) => Promise<Request> }).applyAsync
    const result = typeof applyAsync === 'function'
      ? await applyAsync.call(auth, request)
      : auth.apply(request)
    this._log.trace('Auth applied to request')
    return result
  }

  /**
   * Send one HTTP request through undici and wrap the response
   */
  private async _send(request: Request, fullUrl: URL, options: RequestOptions): Promise<Response> {
    const startTime = Date.now()
    const followRedirects = options.followRedirects ?? this._followRedirects
    const dispatcher = this._getDispatcher(fullUrl, options.followRedirects)

    // Determine timeout (explicit headersTimeout/bodyTimeout override read)
    const timeout = (options.timeout !== undefined
      ? createTimeout(options.timeout)
      : this._timeout).toUndiciOptions()

    let undiciResponse: Dispatcher.ResponseData<unknown>
    try {
      const requestOptions: Record<string, unknown> = {
        method: request.method,
        headers: request.headers.toUndiciHeaders(),
        body: request.body as Dispatcher.DispatchOptions['body'],
        dispatcher,
        signal: options.signal,
        headersTimeout: timeout.headersTimeout,
        bodyTimeout: timeout.bodyTimeout
      }
      if (!followRedirects) {
        // Read per dispatch by undici's redirect interceptor: 0 disables it
        requestOptions['maxRedirections'] = 0
      }
      this._log.trace('Outbound request', {
        method: request.method,
        url: fullUrl.toString(),
        headerNames: Object.keys(request.headers.toUndiciHeaders()),
        hasBody: request.body !== null && request.body !== undefined,
        headersTimeout: timeout.headersTimeout,
        bodyTimeout: timeout.bodyTimeout
      })
      undiciResponse = await undiciRequest(fullUrl.toString(), requestOptions as Parameters<typeof undiciRequest>[1])
    } catch (err) {
      this._log.error('Request failed', {
        method: request.method,
        url: fullUrl.toString(),
        error: (err as Error).message,
        duration: Date.now() - startTime
      })

      const mapped = mapUndiciError(err, request)
      if (followRedirects && /redirect loop/i.test(mapped.message)) {
        throw new TooManyRedirectsError(this._maxRedirects, this._maxRedirects, undefined, request, { cause: err })
      }
      throw mapped
    }

    // After redirects the final request URL is the last entry of undici's history
    const history = (undiciResponse.context as { history?: URL[] } | undefined)?.history
    const finalUrl = history && history.length > 1 ? history[history.length - 1]! : null
    const finalRequest = finalUrl ? request.clone({ url: finalUrl }) : request

    const response = new Response({
      statusCode: undiciResponse.statusCode,
      headers: undiciResponse.headers as Record<string, string | string[]>,
      body: this._wrapBody(undiciResponse.body as unknown as Readable, finalRequest),
      request: finalRequest
    })

    this._log.debug('Request completed', {
      method: request.method,
      url: fullUrl.toString(),
      statusCode: response.statusCode,
      duration: Date.now() - startTime
    })

    // Redirect limit reached: undici returns the last 3xx instead of throwing
    const redirectCount = history ? history.length - 1 : 0
    if (
      followRedirects &&
      response.isRedirect &&
      response.headers.has('location') &&
      redirectCount >= this._maxRedirects
    ) {
      await response.aclose()
      throw new TooManyRedirectsError(this._maxRedirects, redirectCount, response, finalRequest)
    }

    return response
  }

  /**
   * Map errors raised while the body is read (body timeout, max size, socket
   * reset) to library errors. Destroying the wrapper destroys the source so
   * the connection is released.
   */
  private _wrapBody(source: Readable, request: Request): Readable {
    const wrapped = new PassThrough()
    source.on('error', (err) => {
      wrapped.destroy(mapUndiciError(err, request))
    })
    wrapped.on('close', () => {
      if (!source.destroyed && !source.readableEnded) {
        source.destroy()
      }
    })
    source.pipe(wrapped)
    return wrapped
  }

  /**
   * Build full URL from path and params
   */
  private _buildUrl(url: string, params?: QueryParams): URL {
    // Build base URL
    let fullUrl = buildURL(this._baseUrl, url)

    // Merge default params
    if (this._defaultParams) {
      fullUrl = buildURLWithParams(fullUrl, this._defaultParams)
    }

    // Merge request params
    if (params) {
      fullUrl = buildURLWithParams(fullUrl, params)
    }

    return fullUrl
  }

  /**
   * Build headers: per-request header names replace defaults; repeated
   * values for one name within the per-request headers are all kept.
   */
  private _buildHeaders(requestHeaders?: import('../models/headers.js').HeadersInit): Headers {
    const headers = this._defaultHeaders.clone()

    if (requestHeaders) {
      const additional = createHeaders(requestHeaders)
      for (const name of additional.keys()) {
        headers.delete(name)
      }
      for (const [name, value] of additional) {
        headers.append(name, value)
      }
    }

    return headers
  }

  /**
   * Create a ProxyAgent with the client's redirect and user interceptors
   */
  private _createProxyDispatcher(
    proxy: Proxy,
    tlsOpts: Record<string, unknown> | undefined,
    userInterceptors?: Dispatcher.DispatchInterceptor[]
  ): Dispatcher {
    const chain: Dispatcher.DispatcherComposeInterceptor[] = []
    if (this._followRedirects) {
      chain.push(undiciInterceptors.redirect({ maxRedirections: this._maxRedirects }))
    }
    if (userInterceptors) {
      chain.push(...(userInterceptors as Dispatcher.DispatcherComposeInterceptor[]))
    }
    const agent = new ProxyAgent(proxy.toUndiciOptions(tlsOpts))
    const dispatcher = chain.length > 0 ? agent.compose(chain) : agent
    this._proxyDispatchers.set(dispatcher, proxy)
    return dispatcher
  }

  /**
   * Get dispatcher for URL
   *
   * @param followOverride - per-request followRedirects (undefined = client default)
   */
  private _getDispatcher(url: URL, followOverride?: boolean): Dispatcher {
    // Check mount router first
    let mounted = this._mountRouter.getDispatcher(url)

    // NO_PROXY: bypass a client-created proxy for matching hosts
    if (mounted) {
      const proxy = this._proxyDispatchers.get(mounted)
      if (proxy?.shouldBypass(url.toString())) {
        this._log.trace('Bypassing proxy (no_proxy)', { url: url.toString() })
        mounted = null
      }
    }

    // Redirects are a client-level concern (as in httpx), whatever the transport
    const follow = followOverride ?? this._followRedirects
    const forceRedirects = follow && !this._followRedirects

    if (mounted) {
      // Client-created proxy dispatchers already carry the client's redirect handling
      const hasRedirects = this._followRedirects && this._proxyDispatchers.has(mounted)
      if (!follow || hasRedirects) {
        return mounted
      }
      let composed = this._redirectMounts.get(mounted)
      if (!composed) {
        composed = mounted.compose(undiciInterceptors.redirect({ maxRedirections: this._maxRedirects }))
        this._redirectMounts.set(mounted, composed)
      }
      return composed
    }

    if (forceRedirects) {
      this._redirectFactory ??= new DispatcherFactory({ ...this._dispatcherOptions, followRedirects: true })
      return this._redirectFactory.getDispatcher(url)
    }

    // Use dispatcher factory
    return this._dispatcherFactory.getDispatcher(url)
  }

  /**
   * Call request hooks
   */
  private async _callRequestHooks(request: Request): Promise<void> {
    const hooks = this._eventHooks.request
    if (!hooks || hooks.length === 0) return

    for (const hook of hooks) {
      await hook(request)
    }
  }

  /**
   * Call response hooks
   */
  private async _callResponseHooks(response: Response): Promise<void> {
    const hooks = this._eventHooks.response
    if (!hooks || hooks.length === 0) return

    for (const hook of hooks) {
      await hook(response)
    }
  }

  /**
   * Ensure client is not closed
   */
  private _ensureNotClosed(): void {
    if (this._closed) {
      throw new Error('Client has been closed')
    }
  }
}

/**
 * Alias for AsyncClient (httpx compatibility)
 */
export const Client = AsyncClient
