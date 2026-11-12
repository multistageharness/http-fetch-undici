/**
 * SDK exports for fetch-undici
 *
 * Provides simplified interfaces for CLI, LLM Agent, and DevTools.
 */

export { SDK, createSDK, JitterStrategy, CircuitBreaker, CircuitOpenError } from './core.js'
export type { SDKConfig, SDKAuthConfig, SDKResponse, CircuitBreakerConfig, RetryConfig } from './core.js'

export { CLIContext, createCLIContext } from './cli.js'
export type { CLIContextOptions, DownloadResult, ProgressCallback } from './cli.js'

export { AgentHTTPClient, createAgentHTTPClient } from './agent.js'
export type { AgentHTTPClientOptions, AgentResponse } from './agent.js'

export {
  PoolClient,
  getPool,
  closePool,
  closeAllPools,
  getActivePoolOrigins
} from './pool.js'
export type {
  PoolConfig,
  RequestOptions
} from './pool.js'
