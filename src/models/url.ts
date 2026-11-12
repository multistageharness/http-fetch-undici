/**
 * URL utilities for fetch-undici
 *
 * Provides httpx-compatible URL handling with base URL joining.
 */

import { logger } from '../logger.js'
import { InvalidURLError } from '../exceptions/base.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Query parameter types */
export type QueryParamValue = string | number | boolean
export type QueryParams = Record<string, QueryParamValue | QueryParamValue[]>

/** Absolute URL with an authority: RFC 3986 scheme followed by `://` */
const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//

/** Default ports for schemes whose URLs normalize the port away */
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 }

/** Mount pattern: `scheme://authority/path` (authority and path optional) */
const PATTERN_RE = /^([a-zA-Z][a-zA-Z\d+.-]*):\/\/([^/?#]*)([^?#]*)/

/**
 * Join base URL with path
 *
 * @example
 * ```typescript
 * joinURL('https://api.example.com', '/users') // https://api.example.com/users
 * joinURL('https://api.example.com/v1/', '/users') // https://api.example.com/v1/users
 * joinURL('https://api.example.com/v1', '/users') // https://api.example.com/v1/users
 * ```
 */
export function joinURL(base: string | URL, path: string): URL {
  const baseStr = base instanceof URL ? base.toString() : base

  // If path is an absolute URL (any `scheme://`, case-insensitive), use it directly
  if (ABSOLUTE_URL_RE.test(path)) {
    return new URL(path)
  }

  // Handle relative paths
  const baseURL = new URL(baseStr)

  // Normalize base path: ensure it ends with /
  let basePath = baseURL.pathname
  if (!basePath.endsWith('/')) {
    basePath += '/'
  }

  // Strip leading / from path to avoid double slashes
  const cleanPath = path.startsWith('/') ? path.slice(1) : path

  // Resolve as a dot-relative reference against the base root. This keeps the
  // base scheme, userinfo, host and port, drops the base query/fragment, and a
  // joined path starting with '//' can never be read as a new authority.
  const root = new URL(baseURL)
  root.pathname = '/'
  root.search = ''
  root.hash = ''

  return new URL(`.${basePath}${cleanPath}`, root)
}

/**
 * Add query parameters to URL
 *
 * @example
 * ```typescript
 * addParams('https://api.example.com/users', { page: 1, limit: 10 })
 * // https://api.example.com/users?page=1&limit=10
 *
 * addParams('https://api.example.com/users?existing=value', { page: 1 })
 * // https://api.example.com/users?existing=value&page=1
 * ```
 */
export function addParams(url: string | URL, params?: QueryParams | null): URL {
  const result = new URL(url instanceof URL ? url.toString() : url)

  if (!params) {
    return result
  }

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      // Multiple values for same key
      for (const v of value) {
        result.searchParams.append(key, String(v))
      }
    } else if (value !== undefined && value !== null) {
      result.searchParams.append(key, String(value))
    }
  }

  log.trace('Added params to URL', {
    url: result.toString(),
    paramCount: Object.keys(params).length
  })

  return result
}

/**
 * Build full URL from base, path, and params
 */
export function buildURL(base?: string | URL | null, path?: string, params?: QueryParams): URL {
  let url: URL

  if (!base && !path) {
    throw new Error('Either base or path must be provided')
  }

  try {
    if (base && path) {
      url = joinURL(base, path)
    } else if (base) {
      url = new URL(base instanceof URL ? base.toString() : base)
    } else {
      url = new URL(path!)
    }
  } catch (err) {
    const input = path || String(base)
    log.debug('Invalid URL', { url: input, error: (err as Error).message })
    throw new InvalidURLError(input, undefined, { cause: err })
  }

  if (params) {
    url = addParams(url, params)
  }

  log.trace('Built URL', { url: url.toString() })

  return url
}

/**
 * Parse URL into components
 */
export interface URLComponents {
  scheme: string
  host: string
  port: number | null
  path: string
  query: string
  fragment: string
  origin: string
}

/**
 * Parse URL into components
 */
export function parseURL(url: string | URL): URLComponents {
  const parsed = url instanceof URL ? url : new URL(url)

  return {
    scheme: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : null,
    path: parsed.pathname,
    query: parsed.search.replace('?', ''),
    fragment: parsed.hash.replace('#', ''),
    origin: parsed.origin
  }
}

/** Parsed mount pattern */
interface ParsedPattern {
  /** Lowercase scheme, or null for `all` (any scheme) */
  scheme: string | null
  /** Lowercase host, '' for any host, may start with `*` (wildcard) */
  host: string
  /** Explicit port, or null for any port */
  port: number | null
  /** Path prefix without trailing slashes ('' for any path) */
  path: string
}

/**
 * Parse a mount pattern (`scheme://host:port/path`)
 *
 * @returns Parsed pattern, or null if the pattern is not of that form
 */
function parsePattern(pattern: string): ParsedPattern | null {
  const m = PATTERN_RE.exec(pattern)
  if (!m) {
    return null
  }

  const scheme = m[1]!.toLowerCase()

  // Split an optional port off the authority (IPv6 literals keep their brackets)
  const authority = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(m[2]!.toLowerCase())
  if (!authority) {
    return null
  }
  const host = authority[1]!
  const port = authority[2] ? Number.parseInt(authority[2], 10) : null

  return {
    scheme: scheme === 'all' ? null : scheme,
    host: host === '*' ? '' : host,
    port,
    path: m[3]!.replace(/\/+$/, '')
  }
}

/**
 * Check whether a hostname matches a pattern host
 *
 * Follows httpx mount semantics:
 * - `example.com` matches only `example.com`
 * - `*.example.com` matches subdomains, not `example.com` itself
 * - `*example.com` matches `example.com` and its subdomains
 */
function matchHost(hostname: string, patternHost: string): boolean {
  if (patternHost === '') {
    return true
  }
  if (patternHost.startsWith('*.')) {
    return hostname.endsWith(patternHost.slice(1))
  }
  if (patternHost.startsWith('*')) {
    const domain = patternHost.slice(1)
    return hostname === domain || hostname.endsWith(`.${domain}`)
  }
  return hostname === patternHost
}

/**
 * Check if URL matches a pattern
 *
 * Patterns follow httpx mount semantics, extended with path prefixes:
 * - `all://` matches every URL; `http://` / `https://` match a scheme
 * - `all://example.com` matches that host on any scheme
 * - Host must match exactly (`*.example.com` / `*example.com` wildcards supported)
 * - A port in the pattern must match; without a port any port matches
 * - A path matches on segment boundaries (`/api` matches `/api/x`, not `/apiv2`)
 *
 * @example
 * ```typescript
 * matchURLPattern('https://api.example.com/v1/users', 'https://api.example.com/v1/')
 * // true
 *
 * matchURLPattern('https://api.example.com/users', 'https://')
 * // true
 *
 * matchURLPattern('https://api.example.com.evil.com/', 'https://api.example.com')
 * // false
 * ```
 */
export function matchURLPattern(url: string | URL, pattern: string): boolean {
  // Handle all:// pattern
  if (pattern === 'all://') {
    return true
  }

  const parsed = parsePattern(pattern)
  if (!parsed) {
    return false
  }

  let target: URL
  try {
    target = url instanceof URL ? url : new URL(url)
  } catch {
    return false
  }

  const scheme = target.protocol.slice(0, -1)
  if (parsed.scheme !== null && parsed.scheme !== scheme) {
    return false
  }

  if (!matchHost(target.hostname, parsed.host)) {
    return false
  }

  if (parsed.port !== null) {
    const port = target.port ? Number.parseInt(target.port, 10) : DEFAULT_PORTS[scheme]
    if (port !== parsed.port) {
      return false
    }
  }

  const pathname = target.pathname
  return parsed.path === '' || pathname === parsed.path || pathname.startsWith(`${parsed.path}/`)
}

/**
 * Get origin from URL
 */
export function getOrigin(url: string | URL): string {
  const parsed = url instanceof URL ? url : new URL(url)
  return parsed.origin
}

/**
 * Check if URL is valid
 */
export function isValidURL(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}
