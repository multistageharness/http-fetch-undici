/**
 * Proxy configuration for fetch-undici
 *
 * Provides httpx-compatible proxy configuration with Undici mapping.
 */

import { isIP } from 'node:net'
import { logger } from '../logger.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Proxy authentication credentials */
export interface ProxyAuth {
  username: string
  password: string
}

/** Proxy configuration options */
export interface ProxyOptions {
  /** Proxy URL (e.g., http://proxy:8080) */
  url: string
  /** Proxy authentication */
  auth?: ProxyAuth | null
  /** Additional headers to send to proxy */
  headers?: Record<string, string> | null
  /**
   * Patterns to bypass proxy (no_proxy), with curl/httpx semantics:
   * `*` bypasses everything; `example.com`, `.example.com` and `*.example.com`
   * match the domain and all its subdomains; `host:port` only matches that
   * port; IP addresses match exactly (CIDR ranges are not supported).
   * Matching is case-insensitive.
   */
  noProxy?: string[]
}

/** Undici ProxyAgent options */
export interface UndiciProxyOptions {
  uri: string
  token?: string
  headers?: Record<string, string>
  proxyTls?: Record<string, unknown>
  requestTls?: Record<string, unknown>
}

/** Placeholder returned when a proxy URL cannot be safely sanitized */
const UNPARSEABLE_PROXY_URL = '[unparseable proxy URL]'

/** Mask used in place of secrets */
const MASK = '****'

/** Header names whose values must never be shown in logs/serialization */
const SENSITIVE_PROXY_HEADERS = new Set(['proxy-authorization', 'authorization', 'cookie'])

/** Default ports used to match `host:port` NO_PROXY entries */
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

/**
 * Split a NO_PROXY entry into host and optional port.
 *
 * Supports `host`, `host:port`, `[v6]`, `[v6]:port` and bare IPv6 addresses.
 */
function parseNoProxyEntry(entry: string): { host: string; port: string | null } {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']')
    const host = entry.slice(1, end === -1 ? undefined : end)
    const rest = end === -1 ? '' : entry.slice(end + 1)
    return { host, port: rest.startsWith(':') ? rest.slice(1) : null }
  }
  const firstColon = entry.indexOf(':')
  if (firstColon !== -1 && firstColon === entry.lastIndexOf(':')) {
    return { host: entry.slice(0, firstColon), port: entry.slice(firstColon + 1) }
  }
  return { host: entry, port: null }
}

/**
 * Proxy configuration class
 *
 * Provides httpx-compatible proxy configuration.
 *
 * @example
 * ```typescript
 * // Simple proxy
 * const proxy1 = new Proxy({ url: 'http://proxy:8080' })
 *
 * // Proxy with authentication
 * const proxy2 = new Proxy({
 *   url: 'http://proxy:8080',
 *   auth: { username: 'user', password: 'pass' }
 * })
 * ```
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: public API name (httpx.Proxy); renaming would break users
export class Proxy {
  /** Proxy URL */
  readonly url: string

  /** Proxy authentication */
  readonly auth: ProxyAuth | null

  /** Additional headers */
  readonly headers: Record<string, string> | null

  /** No-proxy patterns */
  readonly noProxy: string[]

  constructor(options: ProxyOptions | string) {
    if (typeof options === 'string') {
      this.url = options
      this.auth = null
      this.headers = null
      this.noProxy = []
    } else {
      this.url = options.url
      this.auth = options.auth ?? null
      this.headers = options.headers ?? null
      this.noProxy = options.noProxy ?? []
    }

    // Extract auth from URL if present
    if (!this.auth) {
      const parsedAuth = this.extractAuthFromUrl()
      if (parsedAuth) {
        // Create new instance with extracted auth (immutability)
        Object.defineProperty(this, 'auth', { value: parsedAuth })
      }
    }

    log.debug('Proxy created', {
      url: this.sanitizedUrl,
      hasAuth: !!this.auth,
      noProxyPatterns: this.noProxy.length
    })
  }

  /**
   * Get URL without credentials for logging
   *
   * Never returns the password: parseable URLs have userinfo removed;
   * unparseable URLs have `//user:pass@` masked to `//user:****@`, and anything
   * still containing an `@` is replaced by a fixed placeholder.
   */
  get sanitizedUrl(): string {
    let parsed: URL | null = null
    try {
      parsed = new URL(this.url)
    } catch {
      // Fall through to regex masking below
    }

    if (parsed && parsed.host !== '') {
      parsed.username = ''
      parsed.password = ''
      return parsed.toString()
    }

    let replaced = false
    const masked = this.url.replace(/\/\/([^/?#]*)@/, (_match, userinfo: string) => {
      replaced = true
      const colon = userinfo.indexOf(':')
      return colon === -1 ? `//${MASK}@` : `//${userinfo.slice(0, colon)}:${MASK}@`
    })
    // An '@' without a '//' authority (e.g. "user:pass@host") cannot be masked reliably
    if (!replaced && masked.includes('@')) {
      return UNPARSEABLE_PROXY_URL
    }
    return masked
  }

  /**
   * Safe JSON representation (credentials and sensitive headers masked)
   */
  toJSON(): Record<string, unknown> {
    let headers: Record<string, string> | null = null
    if (this.headers) {
      headers = {}
      for (const [name, value] of Object.entries(this.headers)) {
        headers[name] = SENSITIVE_PROXY_HEADERS.has(name.toLowerCase()) ? MASK : value
      }
    }
    return {
      url: this.sanitizedUrl,
      auth: this.auth ? { username: this.auth.username, password: MASK } : null,
      headers,
      noProxy: this.noProxy
    }
  }

  /**
   * Safe util.inspect representation (same as toJSON)
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Proxy ${JSON.stringify(this.toJSON())}`
  }

  /**
   * Extract auth from URL if present
   */
  private extractAuthFromUrl(): ProxyAuth | null {
    try {
      const parsed = new URL(this.url)
      if (parsed.username || parsed.password) {
        return {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password)
        }
      }
    } catch {
      // Invalid URL, ignore
    }
    return null
  }

  /**
   * Convert to Undici ProxyAgent options
   */
  toUndiciOptions(tlsOptions?: Record<string, unknown>): UndiciProxyOptions {
    const result: UndiciProxyOptions = {
      uri: this.url
    }

    // Add Basic auth token if credentials present
    if (this.auth) {
      const credentials = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString(
        'base64'
      )
      result.token = `Basic ${credentials}`
    }

    // Forward extra headers sent to the proxy (e.g. on CONNECT)
    if (this.headers) {
      result.headers = { ...this.headers }
    }

    // Propagate TLS settings to both proxy and request connections
    if (tlsOptions) {
      result.proxyTls = tlsOptions
      result.requestTls = tlsOptions
    }

    log.trace('Converted to Undici options', {
      uri: this.sanitizedUrl,
      hasToken: !!result.token,
      hasHeaders: !!result.headers,
      hasTls: !!tlsOptions
    })

    return result
  }

  /**
   * Check if URL should bypass proxy
   *
   * Uses curl/httpx NO_PROXY semantics (see {@link ProxyOptions.noProxy}).
   */
  shouldBypass(url: string): boolean {
    if (this.noProxy.length === 0) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Invalid URL
      return false
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
    const port = parsed.port || DEFAULT_PORTS[parsed.protocol] || ''
    const hostIsIP = isIP(hostname) !== 0

    for (const pattern of this.noProxy) {
      const normalizedPattern = pattern.toLowerCase().trim()
      if (normalizedPattern === '') {
        continue
      }

      // '*' bypasses every host
      if (normalizedPattern === '*') {
        return true
      }

      const entry = parseNoProxyEntry(normalizedPattern)
      if (entry.port !== null && entry.port !== port) {
        continue
      }

      // IP addresses match exactly
      if (hostIsIP || isIP(entry.host) !== 0) {
        if (hostname === entry.host) {
          return true
        }
        continue
      }

      // Domain: strip '*.' or '.' prefix; matches apex and any subdomain
      const domain = entry.host.replace(/^\*?\./, '')
      if (domain !== '' && (hostname === domain || hostname.endsWith(`.${domain}`))) {
        return true
      }
    }

    return false
  }
}

/**
 * Create a Proxy instance from various input types
 */
export function createProxy(input?: ProxyOptions | Proxy | string | null): Proxy | null {
  if (!input) {
    return null
  }
  if (input instanceof Proxy) {
    return input
  }
  return new Proxy(input)
}

/**
 * Get proxy configuration from environment variables
 *
 * Precedence (like curl and Python's urllib/httpx): the lowercase variable is
 * checked first, then the uppercase one. Empty values are treated as unset.
 * - http: `http_proxy`, `HTTP_PROXY`
 * - https: `https_proxy`, `HTTPS_PROXY`, then falls back to the http proxy
 *   (`http_proxy`, `HTTP_PROXY`)
 * - noProxy: `no_proxy`, `NO_PROXY`
 */
export function getEnvProxy(): {
  http?: Proxy
  https?: Proxy
  noProxy: string[]
} {
  const httpProxy = process.env['http_proxy'] || process.env['HTTP_PROXY']
  const httpsProxy = process.env['https_proxy'] || process.env['HTTPS_PROXY'] || httpProxy
  const noProxy = (process.env['no_proxy'] || process.env['NO_PROXY'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    http: httpProxy ? new Proxy({ url: httpProxy, noProxy }) : undefined,
    https: httpsProxy ? new Proxy({ url: httpsProxy, noProxy }) : undefined,
    noProxy
  }
}
