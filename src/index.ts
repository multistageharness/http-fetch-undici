/**
 * fetch-undici
 *
 * Polyglot HTTP client wrapper for Node.js using Undici.
 * Provides httpx-compatible API for seamless polyglot development.
 *
 * @packageDocumentation
 */

// ============================================================================
// Convenience Functions
// ============================================================================

export {
  get,
  post,
  put,
  patch,
  del,
  head,
  options,
  request,
  closeDefaultClient
} from './convenience.js'

// Re-export del as delete
export { del as delete } from './convenience.js'

// ============================================================================
// Client
// ============================================================================

export { AsyncClient, Client } from './client/index.js'
export {
  AsyncClientPool,
  PoolType,
  RoundRobinPool,
  createPool as createClientPool,
  createBalancedPool,
  createRoundRobinPool
} from './client/pool_client.js'
export type {
  AsyncClientOptions,
  RequestOptions,
  EventHooks,
  ConnectOptions
} from './client/index.js'
export type { AsyncClientPoolOptions, PoolOptions } from './client/pool_client.js'

// ============================================================================
// Configuration
// ============================================================================

export { Timeout, createTimeout } from './config/timeout.js'
export type { TimeoutOptions } from './config/timeout.js'

export { Limits, createLimits } from './config/limits.js'
export type { LimitsOptions } from './config/limits.js'

export { TLSConfig, createTLSConfig } from './config/tls.js'
export type { TLSConfigOptions } from './config/tls.js'

export { Proxy, createProxy, getEnvProxy } from './config/proxy.js'
export type { ProxyOptions, ProxyAuth } from './config/proxy.js'

// ============================================================================
// Authentication
// ============================================================================

export { Auth, NoAuth, isAuth } from './auth/base.js'
export { BasicAuth, basicAuthFromURL } from './auth/basic.js'
export { BearerAuth, APIKeyAuth } from './auth/bearer.js'
export { DigestAuth } from './auth/digest.js'

// ============================================================================
// Models
// ============================================================================

export { Headers, createHeaders } from './models/headers.js'
export type { HeadersInit } from './models/headers.js'

export { Request, normalizeMethod } from './models/request.js'
export type { HttpMethod, RequestBody } from './models/request.js'

export { Response } from './models/response.js'
export type { ResponseInit } from './models/response.js'

export {
  joinURL,
  addParams,
  buildURL,
  parseURL,
  matchURLPattern,
  getOrigin,
  isValidURL
} from './models/url.js'
export type { QueryParams, QueryParamValue, URLComponents } from './models/url.js'

// ============================================================================
// Exceptions
// ============================================================================

export {
  HTTPError,
  RequestError,
  InvalidURLError,
  RequestOptionsError,
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
  ProxyError,
  HTTPStatusError,
  TooManyRedirectsError,
  StreamError,
  StreamConsumedError,
  StreamClosedError,
  StreamDecodeError,
  mapUndiciError,
  isTimeoutError,
  isNetworkError,
  isTransportError,
  isHTTPError
} from './exceptions/index.js'

// ============================================================================
// Retry & Circuit Breaker
// ============================================================================

export {
  JitterStrategy,
  calculateDelay,
  parseRetryAfter,
  shouldRetryMethod,
  SAFE_METHODS,
  IDEMPOTENT_METHODS
} from './retry/jitter.js'

export {
  CircuitState,
  CircuitBreaker,
  CircuitOpenError
} from './retry/circuit-breaker.js'
export type { CircuitBreakerConfig } from './retry/circuit-breaker.js'

export {
  DEFAULT_RETRY_CONFIG,
  normalizeRetryConfig,
  isRetryableError,
  RETRYABLE_ERROR_CODES
} from './retry/config.js'
export type { RetryConfig } from './retry/config.js'

// ============================================================================
// Transport
// ============================================================================

export { DispatcherFactory, createPool, createAgent } from './transport/dispatcher.js'
export type { DispatcherOptions } from './transport/dispatcher.js'

export { MountRouter, createMountRouter } from './transport/router.js'

// ============================================================================
// Streaming
// ============================================================================

export {
  iterBytes,
  collectBytes,
  createProgressStream,
  iterText,
  collectText,
  iterLines,
  iterNDJSON,
  collectLines,
  iterSSE
} from './streaming/index.js'

// ============================================================================
// Interceptors
// ============================================================================

export { createLoggingInterceptor } from './interceptors/logging.js'
export type { LoggingInterceptorOptions } from './interceptors/logging.js'

export { HooksManager, createHooksManager } from './interceptors/hooks.js'
export type { RequestHook, ResponseHook, EventHooksConfig } from './interceptors/hooks.js'

// ============================================================================
// Logger
// ============================================================================

export { logger, create as createLogger } from './logger.js'
export type { Logger, LogLevel, LogEntry, LoggerOptions } from './logger.js'

// ============================================================================
// Cache
// ============================================================================

export {
  // Storage
  MemoryStorage,
  // Core
  CacheManager,
  defaultKeyStrategy,
  createDotNotationKeyStrategy,
  createHashedKeyStrategy,
  combineKeyStrategies,
  // Wrapper
  CachingClient,
  // Decorators
  withCache,
  withCacheSimple,
  cached,
  createCachedFunction,
  // Middleware
  createCacheHooks,
  createCacheAwareClient
} from './cache/index.js'

export type {
  // Types
  CacheConfig,
  CacheStorage,
  CacheEntry,
  CacheEntryMetadata,
  CacheStats,
  CacheKeyStrategy,
  RequestCacheOptions,
  RequestContext,
  // Storage
  MemoryStorageOptions,
  // Wrapper
  CachingClientOptions,
  CachingRequestOptions,
  // Decorators
  FetchFunction,
  SimpleFetchFunction,
  WithCacheOptions,
  // Middleware
  CacheMiddlewareOptions,
  CacheHooks
} from './cache/index.js'

