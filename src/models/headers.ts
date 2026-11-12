/**
 * Headers model for fetch-undici
 *
 * Provides httpx-compatible Headers class with case-insensitive access.
 */

import { logger } from '../logger.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Types that can be used to initialize Headers */
export type HeadersInit =
  | Headers
  | Record<string, string | string[]>
  | [string, string][]
  | globalThis.Headers

/**
 * HTTP headers collection with case-insensitive access
 *
 * @example
 * ```typescript
 * const headers = new Headers({
 *   'Content-Type': 'application/json',
 *   'X-Custom': 'value'
 * })
 *
 * headers.get('content-type') // 'application/json'
 * headers.set('Authorization', 'Bearer token')
 * headers.append('Accept', 'text/html')
 * ```
 */
export class Headers implements Iterable<[string, string]> {
  /** Internal storage (lowercase keys -> original case + values) */
  private readonly _map: Map<string, { name: string; values: string[] }>

  constructor(init?: HeadersInit) {
    this._map = new Map()

    if (init) {
      this._initFromInput(init)
    }

    log.trace('Headers created', { count: this._map.size })
  }

  /**
   * Initialize from various input types
   */
  private _initFromInput(init: HeadersInit): void {
    if (init instanceof Headers) {
      // Copy from another Headers instance
      for (const entry of init._map.values()) {
        this._map.set(entry.name.toLowerCase(), { name: entry.name, values: [...entry.values] })
      }
    } else if (Array.isArray(init)) {
      // Array of [name, value] tuples
      for (const [name, value] of init) {
        this.append(name, value)
      }
    } else if (init instanceof globalThis.Headers) {
      // Native Headers object
      init.forEach((value, name) => {
        this.append(name, value)
      })
    } else {
      // Plain object
      for (const [name, value] of Object.entries(init)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            this.append(name, v)
          }
        } else {
          this.set(name, value)
        }
      }
    }
  }

  /**
   * Get header value (first value if multiple)
   */
  get(name: string): string | null {
    const entry = this._map.get(name.toLowerCase())
    return entry?.values[0] ?? null
  }

  /**
   * Get all values for a header
   */
  getAll(name: string): string[] {
    const entry = this._map.get(name.toLowerCase())
    return entry?.values ? [...entry.values] : []
  }

  /**
   * Set header value (replaces existing)
   */
  set(name: string, value: string): void {
    const key = name.toLowerCase()
    this._map.set(key, { name, values: [value] })
  }

  /**
   * Append header value (allows multiple values)
   */
  append(name: string, value: string): void {
    const key = name.toLowerCase()
    const existing = this._map.get(key)
    if (existing) {
      existing.values.push(value)
    } else {
      this._map.set(key, { name, values: [value] })
    }
  }

  /**
   * Check if header exists
   */
  has(name: string): boolean {
    return this._map.has(name.toLowerCase())
  }

  /**
   * Delete header
   */
  delete(name: string): void {
    this._map.delete(name.toLowerCase())
  }

  /**
   * Iterate over headers as [name, value] pairs
   * Multiple values yield multiple entries
   */
  *entries(): IterableIterator<[string, string]> {
    for (const { name, values } of this._map.values()) {
      for (const value of values) {
        yield [name, value]
      }
    }
  }

  /**
   * Iterate over header names
   */
  *keys(): IterableIterator<string> {
    for (const { name } of this._map.values()) {
      yield name
    }
  }

  /**
   * Iterate over header values
   */
  *values(): IterableIterator<string> {
    for (const { values } of this._map.values()) {
      for (const value of values) {
        yield value
      }
    }
  }

  /**
   * ForEach iteration
   */
  forEach(callback: (value: string, name: string, headers: Headers) => void): void {
    for (const [name, value] of this.entries()) {
      callback(value, name, this)
    }
  }

  /**
   * Iterator implementation
   */
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }

  /**
   * Number of unique headers
   */
  get size(): number {
    return this._map.size
  }

  /**
   * Convert to plain object (single values)
   */
  toJSON(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const { name, values } of this._map.values()) {
      result[name] = values.join(', ')
    }
    return result
  }

  /**
   * Convert to plain object (all values as arrays)
   */
  toObject(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const { name, values } of this._map.values()) {
      result[name] = [...values]
    }
    return result
  }

  /**
   * Convert to Record<string, string> for Undici
   */
  toUndiciHeaders(): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {}
    for (const { name, values } of this._map.values()) {
      result[name] = values.length === 1 ? values[0]! : values
    }
    return result
  }

  /**
   * Create a copy of headers
   */
  clone(): Headers {
    return new Headers(this)
  }

  /**
   * Merge with other headers
   */
  merge(other?: HeadersInit): Headers {
    const result = this.clone()
    if (other) {
      const otherHeaders = other instanceof Headers ? other : new Headers(other)
      for (const [name, value] of otherHeaders) {
        result.append(name, value)
      }
    }
    return result
  }

  /**
   * String representation
   */
  toString(): string {
    return JSON.stringify(this.toJSON())
  }
}

/**
 * Create Headers from various input types
 *
 * Always returns a new instance (a Headers input is copied, never aliased).
 */
export function createHeaders(input?: HeadersInit | null): Headers {
  return new Headers(input ?? undefined)
}

/**
 * Parse a Content-Length header value
 *
 * Returns null if the value is missing or not a non-negative decimal integer.
 */
export function parseContentLength(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value.trim())) {
    return null
  }
  return Number.parseInt(value, 10)
}
