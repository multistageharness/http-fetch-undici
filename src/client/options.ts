/**
 * Client options for fetch-undici
 */

import type { Dispatcher, buildConnector } from 'undici'
import type { Auth } from '../auth/base.js'
import type { Timeout, TimeoutOptions } from '../config/timeout.js'
import type { Limits, LimitsOptions } from '../config/limits.js'
import type { TLSConfig, TLSConfigOptions } from '../config/tls.js'
// biome-ignore lint/suspicious/noShadowRestrictedNames: library's exported Proxy config class
import type { Proxy, ProxyOptions } from '../config/proxy.js'
import type { HeadersInit } from '../models/headers.js'
import type { QueryParams } from '../models/url.js'
import type { Logger } from '../logger.js'
import type { RetryConfig } from '../retry/config.js'
import type { CircuitBreakerConfig } from '../retry/circuit-breaker.js'

/** Connect options type */
export type ConnectOptions = buildConnector.BuildOptions

/** Event hooks */
export interface EventHooks {
  /** Called before request is sent */
  request?: ((request: import('../models/request.js').Request) => void | Promise<void>)[]
  /** Called after response is received */
  response?: ((response: import('../models/response.js').Response) => void | Promise<void>)[]
}

/** AsyncClient constructor options */
export interface AsyncClientOptions {
  /** Base URL for all requests */
  baseUrl?: string
  /** Alias for baseUrl (snake_case) */
  base_url?: string

  /** Default headers for all requests */
  headers?: HeadersInit

  /** Default query parameters */
  params?: QueryParams

  /** Authentication handler */
  auth?: Auth

  /** Timeout configuration */
  timeout?: Timeout | TimeoutOptions | number | null

  /** Connection limits */
  limits?: Limits | LimitsOptions

  /** TLS/SSL configuration */
  tls?: TLSConfig | TLSConfigOptions | boolean
  /** Alias for tls */
  verify?: boolean

  /** Proxy configuration */
  proxy?: Proxy | ProxyOptions | string | null

  /** Use environment proxy settings */
  trustEnv?: boolean
  /** Alias for trustEnv (snake_case) */
  trust_env?: boolean

  /** Enable HTTP/2 */
  http2?: boolean

  /** Allow HTTP/2 connections. Default: true */
  allowH2?: boolean
  /** Alias (snake_case) */
  allow_h2?: boolean

  /** Maximum response body size in bytes. -1 to disable (default: -1) */
  maxResponseSize?: number
  /** Alias (snake_case) */
  max_response_size?: number

  /** Custom connect options for socket creation */
  connect?: ConnectOptions

  /** Pipelining factor (1 = no pipelining). Default: 1 */
  pipelining?: number

  /** Undici interceptors */
  interceptors?: Dispatcher.DispatchInterceptor[]

  /** Follow redirects */
  followRedirects?: boolean
  /** Alias (snake_case) */
  follow_redirects?: boolean

  /** Maximum redirects */
  maxRedirects?: number
  /** Alias (snake_case) */
  max_redirects?: number

  /** Event hooks */
  eventHooks?: EventHooks
  /** Alias (snake_case) */
  event_hooks?: EventHooks

  /** URL pattern mounts */
  mounts?: Record<string, Dispatcher>

  /** Retry configuration */
  retry?: RetryConfig

  /** Circuit breaker configuration */
  circuitBreaker?: CircuitBreakerConfig
  /** Alias (snake_case) */
  circuit_breaker?: CircuitBreakerConfig

  /** Custom logger */
  logger?: Logger
}

/** Request options */
export interface RequestOptions {
  /** Request headers */
  headers?: HeadersInit

  /** Query parameters */
  params?: QueryParams

  /** JSON body */
  json?: unknown

  /** Form data */
  data?: Record<string, unknown> | FormData | URLSearchParams

  /** Raw content */
  content?: string | Buffer | Uint8Array

  /** File uploads */
  files?: Record<string, import('../request/body.js').FileUpload | Buffer | string>

  /** Override auth for this request */
  auth?: Auth | null

  /** Override timeout for this request */
  timeout?: Timeout | TimeoutOptions | number | null

  /** Override follow redirects */
  followRedirects?: boolean
  /** Alias (snake_case) */
  follow_redirects?: boolean

  /** Abort signal */
  signal?: AbortSignal
}

/**
 * Normalize client options (handle aliases)
 */
export function normalizeClientOptions(options?: AsyncClientOptions): AsyncClientOptions {
  if (!options) return {}

  return {
    baseUrl: options.baseUrl ?? options.base_url,
    headers: options.headers,
    params: options.params,
    auth: options.auth,
    timeout: options.timeout,
    limits: options.limits,
    tls: options.tls ?? (options.verify !== undefined ? { verify: options.verify } : undefined),
    proxy: options.proxy,
    trustEnv: options.trustEnv ?? options.trust_env,
    http2: options.http2,
    allowH2: options.allowH2 ?? options.allow_h2 ?? true,
    maxResponseSize: options.maxResponseSize ?? options.max_response_size ?? -1,
    connect: options.connect,
    pipelining: options.pipelining ?? 1,
    interceptors: options.interceptors,
    followRedirects: options.followRedirects ?? options.follow_redirects ?? true,
    maxRedirects: options.maxRedirects ?? options.max_redirects ?? 10,
    eventHooks: options.eventHooks ?? options.event_hooks,
    mounts: options.mounts,
    retry: options.retry,
    circuitBreaker: options.circuitBreaker ?? options.circuit_breaker,
    logger: options.logger
  }
}

/**
 * Normalize request options (handle aliases)
 */
export function normalizeRequestOptions(options?: RequestOptions): RequestOptions {
  if (!options) return {}

  return {
    headers: options.headers,
    params: options.params,
    json: options.json,
    data: options.data,
    content: options.content,
    files: options.files,
    auth: options.auth,
    timeout: options.timeout,
    followRedirects: options.followRedirects ?? options.follow_redirects,
    signal: options.signal
  }
}
