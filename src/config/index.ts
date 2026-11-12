/**
 * Configuration exports for fetch-undici
 */

export { Timeout, createTimeout } from './timeout.js'
export type { TimeoutOptions, UndiciTimeoutOptions } from './timeout.js'

export { Limits, createLimits } from './limits.js'
export type { LimitsOptions, UndiciPoolOptions } from './limits.js'

export { TLSConfig, createTLSConfig } from './tls.js'
export type { TLSConfigOptions, UndiciConnectOptions } from './tls.js'

export { Proxy, createProxy, getEnvProxy } from './proxy.js'
export type { ProxyOptions, ProxyAuth, UndiciProxyOptions } from './proxy.js'
