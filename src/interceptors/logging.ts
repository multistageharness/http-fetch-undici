/**
 * Logging interceptor for fetch-undici
 */

import type { IncomingHttpHeaders } from 'node:http'
import type { Dispatcher } from 'undici'
import { logger, type Logger } from '../logger.js'

const defaultLog = logger.create('fetch-undici', import.meta.url)

/** Logging interceptor options */
export interface LoggingInterceptorOptions {
  /** Logger instance */
  logger?: Logger
  /** Log request body */
  logBody?: boolean
  /** Log headers */
  logHeaders?: boolean
  /** Headers to redact */
  redactHeaders?: string[]
}

/**
 * Create a logging interceptor
 *
 * Logs request and response information.
 */
export function createLoggingInterceptor(
  options?: LoggingInterceptorOptions
): Dispatcher.DispatcherComposeInterceptor {
  const log = options?.logger ?? defaultLog
  const logHeaders = options?.logHeaders ?? false
  const redactHeaders = options?.redactHeaders ?? ['authorization', 'cookie', 'x-api-key']

  return (dispatch) => {
    return (opts, handler) => {
      const startTime = Date.now()
      const method = opts.method ?? 'GET'
      const path = opts.path ?? '/'

      log.debug('Request starting', {
        method,
        path,
        ...(logHeaders && opts.headers ? { headers: normalizeRequestHeaders(opts.headers, redactHeaders) } : {})
      })

      const logResponse: LogResponse = (statusCode, getHeaders) => {
        log.debug('Response received', {
          method,
          path,
          statusCode,
          duration: Date.now() - startTime,
          ...(logHeaders ? { headers: getHeaders() } : {})
        })
      }

      const logError = (err: Error): void => {
        log.error('Request failed', {
          method,
          path,
          error: err.message,
          duration: Date.now() - startTime
        })
      }

      return dispatch(opts, wrapHandler(handler, redactHeaders, logResponse, logError))
    }
  }
}

/** undici 7 handler methods (controller-based API) */
const HANDLER_METHODS = ['onRequestStart', 'onRequestUpgrade', 'onResponseData', 'onResponseEnd'] as const

/** Legacy (undici <= 6) handler methods */
const LEGACY_HANDLER_METHODS = ['onConnect', 'onUpgrade', 'onResponseStarted', 'onData', 'onComplete', 'onBodySent'] as const

type AnyHandler = Record<string, unknown>
type LogResponse = (statusCode: number, getHeaders: () => Record<string, string>) => void
type HandlerMethod = (...args: unknown[]) => unknown

/**
 * Wrap a dispatch handler with logging
 *
 * Builds a delegating wrapper rather than spreading the handler, so methods
 * defined on a class prototype are kept and are invoked with the original
 * handler as `this`. The wrapper mirrors the handler's API style: a handler
 * with `onRequestStart` gets the undici 7 controller API, anything else the
 * legacy callback API. Methods the handler lacks are not added, so undici's
 * own capability checks still see the handler's real shape.
 */
function wrapHandler(
  handler: Dispatcher.DispatchHandler,
  redactHeaders: string[],
  logResponse: LogResponse,
  logError: (err: Error) => void
): Dispatcher.DispatchHandler {
  const target = handler as AnyHandler
  const call = (name: string, args: unknown[]): unknown => {
    const fn = target[name]
    return typeof fn === 'function' ? (fn as HandlerMethod).apply(handler, args) : undefined
  }
  const wrapped: AnyHandler = {}

  if (typeof target.onRequestStart === 'function') {
    for (const name of HANDLER_METHODS) {
      if (typeof target[name] === 'function') {
        wrapped[name] = (...args: unknown[]) => call(name, args)
      }
    }

    wrapped.onResponseStart = (
      controller: Dispatcher.DispatchController,
      statusCode: number,
      headers: IncomingHttpHeaders,
      statusMessage?: string
    ): void => {
      logResponse(statusCode, () => normalizeRecordHeaders(headers, redactHeaders))
      call('onResponseStart', [controller, statusCode, headers, statusMessage])
    }

    wrapped.onResponseError = (controller: Dispatcher.DispatchController, err: Error): void => {
      logError(err)
      call('onResponseError', [controller, err])
    }
  } else {
    for (const name of LEGACY_HANDLER_METHODS) {
      if (typeof target[name] === 'function') {
        wrapped[name] = (...args: unknown[]) => call(name, args)
      }
    }

    wrapped.onHeaders = (statusCode: number, headers: Buffer[], resume: () => void, statusText: string): boolean => {
      logResponse(statusCode, () => normalizeResponseHeaders(headers, redactHeaders))
      const result = call('onHeaders', [statusCode, headers, resume, statusText]) as boolean | undefined
      return result ?? true
    }

    wrapped.onError = (err: Error): void => {
      logError(err)
      call('onError', [err])
    }
  }

  return wrapped as Dispatcher.DispatchHandler
}

/**
 * Normalize request headers for logging
 */
function normalizeRequestHeaders(
  headers: Dispatcher.DispatchOptions['headers'],
  redactKeys: string[]
): Record<string, string> {
  const result: Record<string, string> = {}

  if (!headers) return result

  if (Array.isArray(headers)) {
    // Headers as flat array: [name1, value1, name2, value2, ...]
    for (let i = 0; i < headers.length; i += 2) {
      const name = String(headers[i] ?? '')
      const value = String(headers[i + 1] ?? '')
      result[name] = shouldRedact(name, redactKeys) ? '[REDACTED]' : value
    }
  } else if (typeof headers === 'object' && headers !== null) {
    // Handle Iterable or plain object
    if (Symbol.iterator in headers) {
      // Iterable<[string, string | string[] | undefined]>
      for (const entry of headers as Iterable<[string, string | string[] | undefined]>) {
        const [name, value] = entry
        const strValue = Array.isArray(value) ? value.join(', ') : String(value ?? '')
        result[name] = shouldRedact(name, redactKeys) ? '[REDACTED]' : strValue
      }
    } else {
      // IncomingHttpHeaders or Record
      for (const [name, value] of Object.entries(headers)) {
        const strValue = Array.isArray(value) ? value.join(', ') : String(value ?? '')
        result[name] = shouldRedact(name, redactKeys) ? '[REDACTED]' : strValue
      }
    }
  }

  return result
}

/**
 * Normalize response headers (Buffer[]) for logging
 */
function normalizeResponseHeaders(
  headers: Buffer[],
  redactKeys: string[]
): Record<string, string> {
  const result: Record<string, string> = {}

  // Response headers come as alternating Buffer pairs: [name, value, name, value, ...]
  for (let i = 0; i < headers.length; i += 2) {
    const nameBuffer = headers[i]
    const valueBuffer = headers[i + 1]
    if (nameBuffer && valueBuffer) {
      const name = nameBuffer.toString()
      const value = valueBuffer.toString()
      result[name] = shouldRedact(name, redactKeys) ? '[REDACTED]' : value
    }
  }

  return result
}

/**
 * Normalize response headers (object form, undici 7 handler API) for logging
 */
function normalizeRecordHeaders(
  headers: IncomingHttpHeaders,
  redactKeys: string[]
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    const strValue = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    result[name] = shouldRedact(name, redactKeys) ? '[REDACTED]' : strValue
  }

  return result
}

/**
 * Check if header should be redacted
 */
function shouldRedact(name: string, redactKeys: string[]): boolean {
  const lowerName = name.toLowerCase()
  return redactKeys.some((key) => lowerName.includes(key.toLowerCase()))
}
