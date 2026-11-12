/**
 * HTTP Basic Authentication for fetch-undici
 */

import { logger } from '../logger.js'
import type { Request } from '../models/request.js'
import { Auth, SECRET_MASK } from './base.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * HTTP Basic Authentication
 *
 * Adds Authorization header with Base64-encoded credentials.
 *
 * @example
 * ```typescript
 * const auth = new BasicAuth('username', 'password')
 *
 * const client = new AsyncClient({
 *   auth: auth
 * })
 * ```
 */
export class BasicAuth extends Auth {
  private readonly _username: string
  private readonly _password: string
  private readonly _token: string

  /**
   * Create Basic authentication
   *
   * @param username - Username or user identifier (must not contain ':', per RFC 7617)
   * @param password - Password or secret (may contain ':')
   * @throws TypeError if the username contains ':'
   */
  constructor(username: string, password: string) {
    super()
    if (username.includes(':')) {
      throw new TypeError('BasicAuth username must not contain ":" (RFC 7617)')
    }
    this._username = username
    this._password = password
    this._token = Buffer.from(`${username}:${password}`).toString('base64')

    log.debug('BasicAuth created', { username })
  }

  /**
   * Apply Basic auth to request
   */
  apply(request: Request): Request {
    this.logApply('Basic', { username: this._username })

    return request.clone({
      headers: {
        Authorization: `Basic ${this._token}`
      }
    })
  }

  /**
   * Get username
   */
  get username(): string {
    return this._username
  }

  /**
   * Safe JSON representation (password masked)
   */
  override toJSON(): Record<string, unknown> {
    return { type: 'BasicAuth', username: this._username, password: SECRET_MASK }
  }

  /**
   * Check if this matches another BasicAuth
   */
  equals(other: BasicAuth): boolean {
    return this._username === other._username && this._password === other._password
  }
}

/**
 * Create BasicAuth from URL credentials
 *
 * Returns null for invalid URLs, URLs without credentials, malformed
 * percent-encoding, or a decoded username containing ':'.
 *
 * @example
 * ```typescript
 * const auth = BasicAuth.fromURL('https://*****@example.com')
 * ```
 */
export function basicAuthFromURL(url: string | URL): BasicAuth | null {
  try {
    const parsed = url instanceof URL ? url : new URL(url)
    if (parsed.username || parsed.password) {
      return new BasicAuth(
        decodeURIComponent(parsed.username),
        decodeURIComponent(parsed.password)
      )
    }
  } catch {
    // Invalid URL
  }
  return null
}
