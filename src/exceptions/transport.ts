/**
 * Transport-level exceptions for fetch-undici
 *
 * Handles network and connection errors, timeout errors, etc.
 */

import type { Request } from '../models/request.js'
import { RequestError, type HTTPErrorOptions } from './base.js'

/**
 * Base class for transport-level errors
 *
 * Occurs during network communication (connection, read, write).
 */
export class TransportError extends RequestError {
  constructor(message: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, options)
    this.name = 'TransportError'
  }
}

// ============================================================================
// Timeout Errors
// ============================================================================

/**
 * Base class for timeout errors
 */
export class TimeoutError extends TransportError {
  /** The timeout value that was exceeded (in milliseconds) */
  readonly timeout?: number

  constructor(message: string, timeout?: number, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, options)
    this.name = 'TimeoutError'
    this.timeout = timeout
  }
}

/**
 * Connection timeout - failed to establish connection within time limit
 */
export class ConnectTimeoutError extends TimeoutError {
  constructor(timeout?: number, request?: Request, options?: HTTPErrorOptions) {
    const msg = timeout !== undefined
      ? `Connection timed out after ${timeout}ms`
      : 'Connection timed out'
    super(msg, timeout, request, options)
    this.name = 'ConnectTimeoutError'
  }
}

/**
 * Read timeout - failed to receive data within time limit
 */
export class ReadTimeoutError extends TimeoutError {
  constructor(timeout?: number, request?: Request, options?: HTTPErrorOptions) {
    const msg = timeout !== undefined
      ? `Read timed out after ${timeout}ms`
      : 'Read timed out'
    super(msg, timeout, request, options)
    this.name = 'ReadTimeoutError'
  }
}

/**
 * Write timeout - failed to send data within time limit
 */
export class WriteTimeoutError extends TimeoutError {
  constructor(timeout?: number, request?: Request, options?: HTTPErrorOptions) {
    const msg = timeout !== undefined
      ? `Write timed out after ${timeout}ms`
      : 'Write timed out'
    super(msg, timeout, request, options)
    this.name = 'WriteTimeoutError'
  }
}

/**
 * Pool timeout - failed to acquire connection from pool within time limit
 */
export class PoolTimeoutError extends TimeoutError {
  constructor(timeout?: number, request?: Request, options?: HTTPErrorOptions) {
    const msg = timeout !== undefined
      ? `Pool acquisition timed out after ${timeout}ms`
      : 'Pool acquisition timed out'
    super(msg, timeout, request, options)
    this.name = 'PoolTimeoutError'
  }
}

// ============================================================================
// Network Errors
// ============================================================================

/**
 * Base class for network connectivity errors
 */
export class NetworkError extends TransportError {
  /** The error code from the underlying system (e.g., ECONNREFUSED) */
  declare readonly code?: string

  constructor(message: string, code?: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, { ...options, code: code ?? options?.code })
    this.name = 'NetworkError'
  }
}

/**
 * Connection error - failed to establish connection
 */
export class ConnectError extends NetworkError {
  readonly host?: string
  readonly port?: number

  constructor(
    message: string,
    host?: string,
    port?: number,
    code?: string,
    request?: Request,
    options?: HTTPErrorOptions
  ) {
    super(message, code, request, options)
    this.name = 'ConnectError'
    this.host = host
    this.port = port
  }
}

/**
 * Socket error - error on established socket
 */
export class SocketError extends NetworkError {
  constructor(message: string, code?: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, code, request, options)
    this.name = 'SocketError'
  }
}

/**
 * DNS resolution error
 */
export class DNSError extends NetworkError {
  readonly hostname: string

  constructor(hostname: string, code?: string, request?: Request, options?: HTTPErrorOptions) {
    super(`DNS resolution failed for ${hostname}`, code, request, options)
    this.name = 'DNSError'
    this.hostname = hostname
  }
}

/**
 * TLS/SSL error
 */
export class TLSError extends TransportError {
  constructor(message: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, options)
    this.name = 'TLSError'
  }
}

/**
 * Proxy connection error
 */
export class ProxyError extends TransportError {
  readonly proxyUrl?: string

  constructor(message: string, proxyUrl?: string, request?: Request, options?: HTTPErrorOptions) {
    super(message, request, options)
    this.name = 'ProxyError'
    this.proxyUrl = proxyUrl
  }
}
