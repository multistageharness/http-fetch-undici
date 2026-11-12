/**
 * TLS/SSL configuration for fetch-undici
 *
 * Provides httpx-compatible TLS configuration with Undici mapping.
 */

import type { TlsOptions } from 'node:tls'
import { logger } from '../logger.js'

const log = logger.create('fetch-undici', import.meta.url)

/** TLS configuration options */
export interface TLSConfigOptions {
  /** Verify server certificate (default: true) */
  verify?: boolean
  /** Client certificate (PEM format) */
  cert?: Buffer | string | null
  /** Client private key (PEM format) */
  key?: Buffer | string | null
  /** CA certificate(s) for verification */
  ca?: Buffer | string | (Buffer | string)[] | null
  /** Private key passphrase */
  passphrase?: string | null
  /** Minimum TLS version */
  minVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'
  /** Maximum TLS version */
  maxVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'
  /** Server name for SNI */
  servername?: string
  /** Allowed cipher suites */
  ciphers?: string
  /** ALPN protocols */
  ALPNProtocols?: string[]
}

/** Undici connect options for TLS */
export interface UndiciConnectOptions {
  rejectUnauthorized?: boolean
  cert?: Buffer | string
  key?: Buffer | string
  ca?: Buffer | string | (Buffer | string)[]
  passphrase?: string
  minVersion?: TlsOptions['minVersion']
  maxVersion?: TlsOptions['maxVersion']
  servername?: string
  ciphers?: string
  ALPNProtocols?: string[]
}

/**
 * TLS configuration class
 *
 * Provides httpx-compatible TLS configuration.
 *
 * @example
 * ```typescript
 * // Skip verification (development only!)
 * const tlsConfig1 = new TLSConfig({ verify: false })
 *
 * // mTLS configuration
 * const tlsConfig2 = new TLSConfig({
 *   cert: fs.readFileSync('/path/to/client.pem'),
 *   key: fs.readFileSync('/path/to/client-key.pem'),
 *   ca: fs.readFileSync('/path/to/ca.pem')
 * })
 * ```
 */
export class TLSConfig {
  /** Verify server certificate */
  readonly verify: boolean

  /** Client certificate */
  readonly cert: Buffer | string | null

  /** Client private key */
  readonly key: Buffer | string | null

  /** CA certificate(s) */
  readonly ca: Buffer | string | (Buffer | string)[] | null

  /** Private key passphrase */
  readonly passphrase: string | null

  /** Minimum TLS version */
  readonly minVersion: TLSConfigOptions['minVersion']

  /** Maximum TLS version */
  readonly maxVersion: TLSConfigOptions['maxVersion']

  /** Server name for SNI */
  readonly servername?: string

  /** Cipher suites */
  readonly ciphers?: string

  /** ALPN protocols */
  readonly ALPNProtocols?: string[]

  constructor(options?: TLSConfigOptions) {
    this.verify = options?.verify ?? true
    this.cert = options?.cert ?? null
    this.key = options?.key ?? null
    this.ca = options?.ca ?? null
    this.passphrase = options?.passphrase ?? null
    this.minVersion = options?.minVersion ?? 'TLSv1.2'
    this.maxVersion = options?.maxVersion
    this.servername = options?.servername
    this.ciphers = options?.ciphers
    this.ALPNProtocols = options?.ALPNProtocols

    log.debug('TLSConfig created', {
      verify: this.verify,
      hasCert: !!this.cert,
      hasKey: !!this.key,
      hasCa: !!this.ca,
      minVersion: this.minVersion
    })
  }

  /**
   * Convert to Undici connect options
   */
  toUndiciOptions(): UndiciConnectOptions {
    const result: UndiciConnectOptions = {
      rejectUnauthorized: this.verify,
      minVersion: this.minVersion
    }

    if (this.cert) {
      result.cert = this.cert
    }

    if (this.key) {
      result.key = this.key
    }

    if (this.ca) {
      result.ca = this.ca
    }

    if (this.passphrase) {
      result.passphrase = this.passphrase
    }

    if (this.maxVersion) {
      result.maxVersion = this.maxVersion
    }

    if (this.servername) {
      result.servername = this.servername
    }

    if (this.ciphers) {
      result.ciphers = this.ciphers
    }

    if (this.ALPNProtocols) {
      result.ALPNProtocols = this.ALPNProtocols
    }

    log.trace('Converted to Undici options', {
      rejectUnauthorized: result.rejectUnauthorized,
      hasCert: !!result.cert,
      hasKey: !!result.key,
      hasCa: !!result.ca
    })

    return result
  }

  /**
   * Safe JSON representation
   *
   * The private key and passphrase are masked; certificate material is
   * reported only as present/absent.
   */
  toJSON(): Record<string, unknown> {
    return {
      verify: this.verify,
      cert: this.cert ? '[present]' : null,
      key: this.key ? '****' : null,
      ca: this.ca ? '[present]' : null,
      passphrase: this.passphrase ? '****' : null,
      minVersion: this.minVersion,
      maxVersion: this.maxVersion,
      servername: this.servername,
      ciphers: this.ciphers,
      ALPNProtocols: this.ALPNProtocols
    }
  }

  /**
   * Safe util.inspect representation (same as toJSON)
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `TLSConfig ${JSON.stringify(this.toJSON())}`
  }

  /**
   * Check if mTLS is configured
   */
  get isMTLS(): boolean {
    return !!(this.cert && this.key)
  }
}

/**
 * Create a TLSConfig instance from various input types
 */
export function createTLSConfig(input?: TLSConfigOptions | TLSConfig | boolean): TLSConfig {
  if (input instanceof TLSConfig) {
    return input
  }
  if (typeof input === 'boolean') {
    return new TLSConfig({ verify: input })
  }
  return new TLSConfig(input)
}
