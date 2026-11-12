/**
 * HTTP Digest Authentication for fetch-undici
 */

import { createHash, randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import type { Request } from '../models/request.js'
import type { Response } from '../models/response.js'
import { Auth, SECRET_MASK } from './base.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Digest challenge parameters */
interface DigestChallenge {
  realm: string
  nonce: string
  qop?: string
  opaque?: string
  algorithm?: string
  stale?: boolean
}

/** A single parsed authentication challenge (scheme + auth-params) */
interface ParsedChallenge {
  scheme: string
  params: Record<string, string>
}

/** Map of supported Digest algorithms (without -sess suffix) to Node.js hash names */
const HASH_ALGORITHMS: Record<string, string> = {
  MD5: 'md5',
  'SHA-256': 'sha256',
  'SHA-512-256': 'sha512-256'
}

/** RFC 7230 token characters */
const TOKEN_RE = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y

/**
 * Parse a WWW-Authenticate header value into its challenges.
 *
 * Handles multiple schemes in one header (e.g. `Basic realm="a", Digest ...`),
 * quoted strings with backslash escapes, and empty quoted values.
 */
export function parseAuthenticateHeader(header: string): ParsedChallenge[] {
  const challenges: ParsedChallenge[] = []
  let current: ParsedChallenge | null = null
  let i = 0

  const skip = (re: RegExp): void => {
    while (i < header.length && re.test(header[i]!)) i++
  }

  while (i < header.length) {
    skip(/[\s,]/)
    TOKEN_RE.lastIndex = i
    const tokenMatch = TOKEN_RE.exec(header)
    if (!tokenMatch) {
      // Unexpected character; skip it
      i++
      continue
    }
    const token = tokenMatch[0]
    i += token.length
    skip(/\s/)

    if (header[i] !== '=') {
      // A new auth-scheme
      current = { scheme: token, params: {} }
      challenges.push(current)
      continue
    }

    // auth-param: token "=" ( token / quoted-string )
    i++
    skip(/\s/)
    let value = ''
    if (header[i] === '"') {
      i++
      while (i < header.length && header[i] !== '"') {
        if (header[i] === '\\' && i + 1 < header.length) {
          i++
        }
        value += header[i]
        i++
      }
      i++ // closing quote
    } else {
      while (i < header.length && !/[\s,]/.test(header[i]!)) {
        value += header[i]
        i++
      }
    }
    if (current) {
      current.params[token.toLowerCase()] = value
    }
  }

  return challenges
}

/**
 * Escape a value for use inside a quoted-string header parameter
 */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

/**
 * Normalize a Digest algorithm name: upper-case, -sess suffix stripped
 */
function baseAlgorithm(algorithm: string): string {
  const alg = algorithm.toUpperCase()
  return alg.endsWith('-SESS') ? alg.slice(0, -5) : alg
}

/**
 * Check whether a Digest algorithm (with or without -sess) is supported
 */
function isSupportedAlgorithm(algorithm: string | undefined): boolean {
  return Object.hasOwn(HASH_ALGORITHMS, baseAlgorithm(algorithm ?? 'MD5'))
}

/**
 * HTTP Digest Authentication
 *
 * Implements RFC 7616 HTTP Digest Access Authentication.
 * Handles challenge-response flow automatically.
 *
 * Supported algorithms: MD5, SHA-256, SHA-512-256 and their `-sess` variants.
 * Supported qop: `auth` (chosen whenever offered). `auth-int` is not
 * implemented; a challenge offering only `auth-int` (or another unknown qop)
 * or an unsupported algorithm makes `apply` throw.
 *
 * @example
 * ```typescript
 * const auth = new DigestAuth('username', 'password')
 *
 * const client = new AsyncClient({
 *   auth: auth
 * })
 * ```
 */
export class DigestAuth extends Auth {
  private readonly _username: string
  private readonly _password: string
  private _challenge: DigestChallenge | null = null
  private _nonceCount = 0

  constructor(username: string, password: string) {
    super()
    this._username = username
    this._password = password

    log.debug('DigestAuth created', { username })
  }

  /**
   * Digest auth requires challenge-response
   */
  override get requiresChallenge(): boolean {
    return this._challenge === null
  }

  /**
   * Check if we can handle a 401 challenge
   */
  override canHandleChallenge(response: Response): boolean {
    const wwwAuth = response.headers.get('www-authenticate')
    return (
      response.statusCode === 401 &&
      !!wwwAuth &&
      parseAuthenticateHeader(wwwAuth).some((c) => c.scheme.toLowerCase() === 'digest')
    )
  }

  /**
   * Apply Digest auth to request
   *
   * @param request - The request to authenticate
   * @param response - Optional 401 response with challenge
   */
  apply(request: Request, response?: Response): Request {
    // If we have a response, parse the challenge
    if (response) {
      this._parseChallenge(response)
    }

    // If no challenge yet, return request as-is (will trigger 401)
    if (!this._challenge) {
      log.debug('DigestAuth: No challenge yet, sending initial request')
      return request
    }

    // Compute digest response
    const authHeader = this._computeAuthHeader(request)

    this.logApply('Digest', { username: this._username, nonceCount: this._nonceCount })

    return request.clone({
      headers: {
        Authorization: authHeader
      }
    })
  }

  /**
   * Parse WWW-Authenticate header for challenge
   *
   * Picks the first Digest challenge with a supported algorithm (or the first
   * Digest challenge if none is supported, so that apply reports a clear error).
   */
  private _parseChallenge(response: Response): void {
    const wwwAuth = response.headers.get('www-authenticate')
    if (!wwwAuth) {
      log.warn('DigestAuth: No WWW-Authenticate header found')
      return
    }

    const digests = parseAuthenticateHeader(wwwAuth).filter(
      (c) => c.scheme.toLowerCase() === 'digest'
    )
    if (digests.length === 0) {
      log.warn('DigestAuth: Not a Digest challenge')
      return
    }

    const chosen = digests.find((c) => isSupportedAlgorithm(c.params['algorithm'])) ?? digests[0]!
    const params = chosen.params

    if (params['realm'] === undefined || !params['nonce']) {
      log.warn('DigestAuth: Invalid challenge (missing realm or nonce)')
      return
    }

    const challenge: DigestChallenge = {
      realm: params['realm'],
      nonce: params['nonce'],
      qop: params['qop'],
      opaque: params['opaque'],
      algorithm: params['algorithm'],
      stale: params['stale'] !== undefined && params['stale'].toLowerCase() === 'true'
    }

    // Restart the nonce count for a new nonce (stale or not) and for any
    // non-stale challenge (the server rejected our credentials)
    const previousNonce = this._challenge?.nonce
    if (!challenge.stale || challenge.nonce !== previousNonce) {
      this._nonceCount = 0
    }
    this._challenge = challenge

    log.debug('DigestAuth: Challenge parsed', {
      realm: challenge.realm,
      algorithm: challenge.algorithm,
      qop: challenge.qop
    })
  }

  /**
   * Choose a single qop value from the challenge's qop list
   *
   * @returns 'auth' when offered, undefined when the challenge has no qop
   * @throws Error when qop is present but 'auth' is not offered
   */
  private _selectQop(qop: string | undefined): string | undefined {
    if (qop === undefined) {
      return undefined
    }
    const offered = qop
      .split(',')
      .map((q) => q.trim().toLowerCase())
      .filter(Boolean)
    if (offered.length === 0) {
      return undefined
    }
    if (offered.includes('auth')) {
      return 'auth'
    }
    throw new Error(`DigestAuth: unsupported qop "${qop}" (only "auth" is supported)`)
  }

  /**
   * Compute Authorization header value
   */
  private _computeAuthHeader(request: Request): string {
    if (!this._challenge) {
      throw new Error('No challenge available')
    }

    const { realm, nonce, opaque, algorithm = 'MD5' } = this._challenge
    const qop = this._selectQop(this._challenge.qop)

    // Generate client nonce
    const cnonce = randomBytes(16).toString('hex')

    // Get URI
    const uri = request.url.pathname + request.url.search

    // Compute HA1 (validates the algorithm before the nonce count is consumed)
    const ha1 = this._computeHA1(algorithm, realm, nonce, cnonce)

    // Compute HA2
    const ha2 = this._computeHA2(algorithm, request.method, uri)

    // Increment nonce count
    this._nonceCount++
    const nc = this._nonceCount.toString(16).padStart(8, '0')

    // Compute response
    let response: string
    if (qop) {
      response = this._hash(algorithm, `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    } else {
      response = this._hash(algorithm, `${ha1}:${nonce}:${ha2}`)
    }

    // Build header (quoted values are escaped per RFC 7230 quoted-string)
    let header = `Digest username=${quote(this._username)}, realm=${quote(realm)}, nonce=${quote(nonce)}, uri=${quote(uri)}, response="${response}"`

    if (algorithm !== 'MD5') {
      header += `, algorithm=${algorithm}`
    }

    if (qop) {
      header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
    }

    if (opaque !== undefined) {
      header += `, opaque=${quote(opaque)}`
    }

    return header
  }

  /**
   * Compute HA1 hash
   *
   * For `-sess` algorithms (RFC 7616 section 3.4.2):
   * HA1 = H(H(username:realm:password):nonce:cnonce)
   */
  private _computeHA1(algorithm: string, realm: string, nonce?: string, cnonce?: string): string {
    const a1 = `${this._username}:${realm}:${this._password}`
    const ha1 = this._hash(algorithm, a1)

    if (algorithm.toUpperCase().endsWith('-SESS')) {
      return this._hash(algorithm, `${ha1}:${nonce ?? ''}:${cnonce ?? ''}`)
    }

    return ha1
  }

  /**
   * Compute HA2 hash
   */
  private _computeHA2(algorithm: string, method: string, uri: string): string {
    const a2 = `${method}:${uri}`
    return this._hash(algorithm, a2)
  }

  /**
   * Compute hash based on algorithm
   *
   * @throws Error for algorithms other than MD5, SHA-256, SHA-512-256 (and -sess variants)
   */
  private _hash(algorithm: string, data: string): string {
    const alg = baseAlgorithm(algorithm)
    if (!Object.hasOwn(HASH_ALGORITHMS, alg)) {
      throw new Error(
        `DigestAuth: unsupported algorithm "${algorithm}" (supported: MD5, SHA-256, SHA-512-256 and -sess variants)`
      )
    }
    return createHash(HASH_ALGORITHMS[alg]!).update(data).digest('hex')
  }

  /**
   * Safe JSON representation (password masked)
   */
  override toJSON(): Record<string, unknown> {
    return { type: 'DigestAuth', username: this._username, password: SECRET_MASK }
  }

  /**
   * Reset authentication state
   */
  reset(): void {
    this._challenge = null
    this._nonceCount = 0
    log.debug('DigestAuth: State reset')
  }

  /**
   * Get username
   */
  get username(): string {
    return this._username
  }
}
