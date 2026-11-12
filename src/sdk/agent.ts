/**
 * Agent Context for fetch-undici SDK
 *
 * Provides LLM Agent-specific utilities with structured responses.
 */

import { logger, type Logger } from '../logger.js'
import { AsyncClient, type AsyncClientOptions, type RequestOptions } from '../client/index.js'
import type { Response } from '../models/response.js'
import { headersToRecord } from './core.js'
import {
  TimeoutError,
  ConnectError,
  DNSError,
  SocketError,
  NetworkError,
  TLSError,
  ProxyError,
  TooManyRedirectsError
} from '../exceptions/index.js'
import { CircuitOpenError } from '../retry/index.js'

const defaultLog = logger.create('fetch-undici', import.meta.url)

/** Agent response format - structured for LLM consumption */
export interface AgentResponse<T = unknown> {
  /** Whether the request was successful */
  success: boolean
  /** HTTP status code (0 if request failed) */
  statusCode: number
  /** Response data (parsed JSON if applicable) */
  data?: T
  /** Human-readable error message */
  error?: string
  /** Suggestion for error recovery */
  suggestion?: string
  /** Summary of what happened */
  summary: string
  /** Response headers; repeated headers (e.g. set-cookie) are arrays */
  headers: Record<string, string | string[]>
  /** Request duration in milliseconds */
  duration: number
}

/** Agent client options */
export interface AgentHTTPClientOptions extends AsyncClientOptions {
  /** Name of the agent (for logging) */
  agentName?: string
}

/**
 * Agent HTTP Client
 *
 * Provides HTTP functionality optimized for LLM Agent consumption.
 * Returns structured responses with summaries and suggestions.
 *
 * @example
 * ```typescript
 * const agent = new AgentHTTPClient({
 *   baseUrl: 'https://api.example.com',
 *   agentName: 'MyAgent'
 * })
 *
 * const result = await agent.request('GET', '/users', {
 *   description: 'Fetch all users'
 * })
 *
 * // Result format:
 * // {
 * //   success: true,
 * //   statusCode: 200,
 * //   data: [...],
 * //   summary: "Successfully retrieved 25 users"
 * // }
 * ```
 */
export class AgentHTTPClient {
  private readonly _client: AsyncClient
  private readonly _agentName: string
  private readonly _log: Logger

  constructor(options?: AgentHTTPClientOptions) {
    this._agentName = options?.agentName ?? 'Agent'
    this._log = options?.logger ?? defaultLog

    this._client = new AsyncClient({
      ...options,
      followRedirects: options?.followRedirects ?? true
    })

    this._log.info('AgentHTTPClient initialized', { agentName: this._agentName })
  }

  /**
   * Make HTTP request with structured response
   */
  async request<T = unknown>(
    method: string,
    url: string,
    options?: RequestOptions & { description?: string }
  ): Promise<AgentResponse<T>> {
    const startTime = Date.now()
    const description = options?.description ?? `${method} ${url}`

    this._log.debug('Agent request starting', {
      agentName: this._agentName,
      method,
      url,
      description
    })

    try {
      const response = await this._client.request(method, url, options)
      const duration = Date.now() - startTime

      return await this._formatResponse<T>(response, description, duration)
    } catch (err) {
      const duration = Date.now() - startTime
      return this._formatError<T>(err as Error, description, duration)
    }
  }

  /**
   * Make GET request
   */
  async get<T = unknown>(
    url: string,
    options?: RequestOptions & { description?: string }
  ): Promise<AgentResponse<T>> {
    return this.request<T>('GET', url, options)
  }

  /**
   * Make POST request
   */
  async post<T = unknown>(
    url: string,
    data?: unknown,
    options?: RequestOptions & { description?: string }
  ): Promise<AgentResponse<T>> {
    return this.request<T>('POST', url, { ...options, json: data })
  }

  /**
   * Make PUT request
   */
  async put<T = unknown>(
    url: string,
    data?: unknown,
    options?: RequestOptions & { description?: string }
  ): Promise<AgentResponse<T>> {
    return this.request<T>('PUT', url, { ...options, json: data })
  }

  /**
   * Make DELETE request
   */
  async delete<T = unknown>(
    url: string,
    options?: RequestOptions & { description?: string }
  ): Promise<AgentResponse<T>> {
    return this.request<T>('DELETE', url, options)
  }

  /**
   * Close client
   */
  async close(): Promise<void> {
    await this._client.close()
    this._log.info('AgentHTTPClient closed', { agentName: this._agentName })
  }

  /**
   * Format successful response for agent consumption
   */
  private async _formatResponse<T>(
    response: Response,
    description: string,
    duration: number
  ): Promise<AgentResponse<T>> {
    const headers = headersToRecord(response)

    if (response.ok) {
      let data: T | undefined
      let summary: string

      try {
        data = await response.json<T>()

        // Generate summary based on data
        summary = this._generateSuccessSummary(description, data)
      } catch {
        // Not JSON
        summary = `${description} completed successfully with status ${response.statusCode}`
      }

      return {
        success: true,
        statusCode: response.statusCode,
        data,
        summary,
        headers,
        duration
      }
    }

    // Error response
    await response.aclose()
    const { error, suggestion } = this._getErrorInfo(response.statusCode)

    return {
      success: false,
      statusCode: response.statusCode,
      error,
      suggestion,
      summary: `${description} failed with HTTP ${response.statusCode}: ${error}`,
      headers,
      duration
    }
  }

  /**
   * Format error for agent consumption
   */
  private _formatError<T>(
    err: Error,
    description: string,
    duration: number
  ): AgentResponse<T> {
    const { error, suggestion } = this._getNetworkErrorInfo(err)

    return {
      success: false,
      statusCode: 0,
      error,
      suggestion,
      summary: `${description} failed: ${error}`,
      headers: {},
      duration
    }
  }

  /**
   * Generate success summary based on data
   */
  private _generateSuccessSummary(description: string, data: unknown): string {
    if (Array.isArray(data)) {
      return `${description} returned ${data.length} items`
    }

    if (data && typeof data === 'object') {
      const keys = Object.keys(data)
      if (keys.length > 0) {
        return `${description} returned object with keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`
      }
    }

    return `${description} completed successfully`
  }

  /**
   * Get error info based on status code
   */
  private _getErrorInfo(statusCode: number): { error: string; suggestion: string } {
    switch (statusCode) {
      case 400:
        return {
          error: 'Bad Request - The request was malformed',
          suggestion: 'Check the request parameters and body format'
        }
      case 401:
        return {
          error: 'Unauthorized - Authentication required',
          suggestion: 'Provide valid authentication credentials'
        }
      case 403:
        return {
          error: 'Forbidden - Access denied',
          suggestion: 'Check if you have permission to access this resource'
        }
      case 404:
        return {
          error: 'Not Found - Resource does not exist',
          suggestion: 'Verify the URL path and resource ID'
        }
      case 429:
        return {
          error: 'Too Many Requests - Rate limited',
          suggestion: 'Wait before making more requests'
        }
      case 500:
        return {
          error: 'Internal Server Error',
          suggestion: 'The server encountered an error; try again later'
        }
      case 502:
        return {
          error: 'Bad Gateway',
          suggestion: 'The server received an invalid response; try again later'
        }
      case 503:
        return {
          error: 'Service Unavailable',
          suggestion: 'The service is temporarily unavailable; try again later'
        }
      default:
        return {
          error: `HTTP Error ${statusCode}`,
          suggestion: 'Check the status code and adjust your request'
        }
    }
  }

  /**
   * Get network error info
   */
  private _getNetworkErrorInfo(err: Error): { error: string; suggestion: string } {
    if (err instanceof TimeoutError) {
      return {
        error: 'Request timed out',
        suggestion: 'The server took too long to respond; try again or increase timeout'
      }
    }

    if (err instanceof DNSError) {
      return {
        error: 'DNS resolution failed',
        suggestion: 'The hostname could not be resolved; check the URL'
      }
    }

    if (err instanceof ConnectError) {
      return {
        error: 'Connection refused',
        suggestion: 'The server is not accepting connections; verify the URL and server status'
      }
    }

    if (err instanceof SocketError) {
      return {
        error: 'Connection closed unexpectedly',
        suggestion: 'The connection was reset by the server; try again'
      }
    }

    if (err instanceof TLSError) {
      return {
        error: 'TLS/SSL error',
        suggestion: 'Check the server certificate and TLS configuration'
      }
    }

    if (err instanceof ProxyError) {
      return {
        error: 'Proxy error',
        suggestion: 'Check the proxy configuration and that the proxy is reachable'
      }
    }

    if (err instanceof TooManyRedirectsError) {
      return {
        error: 'Too many redirects',
        suggestion: 'The URL redirects in a loop or too many times; check the URL'
      }
    }

    if (err instanceof CircuitOpenError) {
      return {
        error: 'Circuit breaker is open',
        suggestion: 'The service is failing; wait before retrying'
      }
    }

    if (err instanceof NetworkError) {
      return {
        error: `Network error: ${err.message}`,
        suggestion: 'Check network connectivity and try again'
      }
    }

    return {
      error: err.message,
      suggestion: 'Check network connectivity and try again'
    }
  }
}

/**
 * Create Agent HTTP Client
 */
export function createAgentHTTPClient(options?: AgentHTTPClientOptions): AgentHTTPClient {
  return new AgentHTTPClient(options)
}
