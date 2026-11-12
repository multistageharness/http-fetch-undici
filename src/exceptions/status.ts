/**
 * HTTP status-related exceptions for fetch-undici
 *
 * Handles HTTP status code errors (4xx, 5xx) and redirect errors.
 */

import type { Request } from '../models/request.js'
import type { Response } from '../models/response.js'
import { HTTPError } from './base.js'

/**
 * HTTP status error - response received with error status code
 *
 * Thrown when response status is 4xx (client error) or 5xx (server error).
 *
 * @example
 * ```typescript
 * try {
 *   const response = await client.get('/users/999')
 *   response.raiseForStatus()
 * } catch (err) {
 *   if (err instanceof HTTPStatusError) {
 *     console.log('Status:', err.statusCode) // 404
 *     console.log('Response:', await err.response.text())
 *   }
 * }
 * ```
 */
export class HTTPStatusError extends HTTPError {
  /** HTTP status code that caused the error */
  readonly statusCode: number

  /** The response object */
  readonly response: Response

  constructor(response: Response, request?: Request, options?: ErrorOptions) {
    const statusText = getStatusText(response.statusCode)
    const message = `HTTP ${response.statusCode} ${statusText} for URL: ${request?.url ?? 'unknown'}`
    super(message, request, options)
    this.name = 'HTTPStatusError'
    this.statusCode = response.statusCode
    this.response = response
  }

  /** Whether this is a client error (4xx) */
  get isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500
  }

  /** Whether this is a server error (5xx) */
  get isServerError(): boolean {
    return this.statusCode >= 500 && this.statusCode < 600
  }
}

/**
 * Too many redirects error
 *
 * Thrown when redirect limit is exceeded.
 */
export class TooManyRedirectsError extends HTTPError {
  /** Maximum number of redirects allowed */
  readonly maxRedirects: number

  /** Number of redirects that occurred */
  readonly redirectCount: number

  /** The last response before the limit was reached */
  readonly response?: Response

  constructor(
    maxRedirects: number,
    redirectCount: number,
    response?: Response,
    request?: Request,
    options?: ErrorOptions
  ) {
    const message = `Maximum redirects (${maxRedirects}) exceeded after ${redirectCount} redirects`
    super(message, request, options)
    this.name = 'TooManyRedirectsError'
    this.maxRedirects = maxRedirects
    this.redirectCount = redirectCount
    this.response = response
  }
}

/**
 * Get human-readable status text for HTTP status code
 */
function getStatusText(statusCode: number): string {
  const statusTexts: Record<number, string> = {
    // 1xx Informational
    100: 'Continue',
    101: 'Switching Protocols',
    102: 'Processing',
    103: 'Early Hints',

    // 2xx Success
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    203: 'Non-Authoritative Information',
    204: 'No Content',
    205: 'Reset Content',
    206: 'Partial Content',
    207: 'Multi-Status',
    208: 'Already Reported',
    226: 'IM Used',

    // 3xx Redirection
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
    305: 'Use Proxy',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',

    // 4xx Client Errors
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    407: 'Proxy Authentication Required',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    411: 'Length Required',
    412: 'Precondition Failed',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    415: 'Unsupported Media Type',
    416: 'Range Not Satisfiable',
    417: 'Expectation Failed',
    418: "I'm a Teapot",
    421: 'Misdirected Request',
    422: 'Unprocessable Entity',
    423: 'Locked',
    424: 'Failed Dependency',
    425: 'Too Early',
    426: 'Upgrade Required',
    428: 'Precondition Required',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    451: 'Unavailable For Legal Reasons',

    // 5xx Server Errors
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates',
    507: 'Insufficient Storage',
    508: 'Loop Detected',
    510: 'Not Extended',
    511: 'Network Authentication Required'
  }

  return statusTexts[statusCode] ?? 'Unknown Status'
}
