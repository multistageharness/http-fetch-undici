/**
 * Mount Router for fetch-undici
 *
 * Provides URL-pattern based routing to different dispatchers.
 */

import type { Dispatcher } from 'undici'
import { logger } from '../logger.js'
import { matchURLPattern } from '../models/url.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Mount entry with pattern and dispatcher */
interface MountEntry {
  pattern: string
  dispatcher: Dispatcher
  specificity: number
}

/**
 * Calculate specificity score for a pattern authority (`host[:port]`)
 *
 * More labels rank higher; an explicit port ranks above any port and an
 * exact host ranks above a wildcard host with the same label count.
 */
function hostSpecificity(authority: string): number {
  let score = 100 + authority.split('.').length * 10

  if (/:\d+$/.test(authority)) {
    score += 5
  }
  if (authority.startsWith('*')) {
    score -= 5
  }

  return score
}

/**
 * Calculate specificity score for a mount pattern
 *
 * Higher scores are more specific and matched first.
 */
function calculateSpecificity(pattern: string): number {
  // all:// has lowest specificity
  if (pattern === 'all://') {
    return 0
  }

  let score = 0

  // Check for scheme specificity
  if (pattern.startsWith('https://')) {
    score += 10
  } else if (pattern.startsWith('http://')) {
    score += 10
  }

  // Check for host specificity
  const schemeEnd = pattern.indexOf('://')
  if (schemeEnd !== -1) {
    const afterScheme = pattern.slice(schemeEnd + 3)
    const pathStart = afterScheme.indexOf('/')

    if (pathStart !== -1) {
      // Has host
      const host = afterScheme.slice(0, pathStart)
      if (host) {
        score += hostSpecificity(host)
      }

      // Has path
      const path = afterScheme.slice(pathStart)
      if (path && path !== '/') {
        score += 1000
        // More path segments = more specific
        score += path.split('/').filter(Boolean).length * 100
      }
    } else if (afterScheme) {
      // Host only (no trailing slash in pattern)
      score += hostSpecificity(afterScheme)
    }
  }

  return score
}

/**
 * Mount Router for URL-pattern based dispatcher routing
 *
 * Routes requests to different dispatchers based on URL patterns.
 * More specific patterns are matched first.
 *
 * @example
 * ```typescript
 * const router = new MountRouter()
 *
 * // Add mounts (most specific first)
 * router.mount('https://api.example.com/v2/', apiV2Pool)
 * router.mount('https://api.example.com/', apiPool)
 * router.mount('https://', httpsAgent)
 * router.mount('all://', defaultAgent)
 *
 * // Get dispatcher for URL
 * const dispatcher = router.getDispatcher('https://api.example.com/v2/users')
 * // Returns apiV2Pool
 * ```
 */
export class MountRouter {
  private readonly _mounts: MountEntry[] = []
  private _defaultDispatcher: Dispatcher | null = null

  constructor() {
    log.debug('MountRouter created')
  }

  /**
   * Add a mount pattern with dispatcher
   *
   * @param pattern - URL pattern (e.g., 'https://api.example.com/v2/')
   * @param dispatcher - Undici dispatcher for this pattern
   */
  mount(pattern: string, dispatcher: Dispatcher): void {
    const specificity = calculateSpecificity(pattern)

    // Handle all:// as default
    if (pattern === 'all://') {
      this._defaultDispatcher = dispatcher
      log.debug('Set default dispatcher (all://)')
      return
    }

    // Re-mounting a pattern replaces the previous mount
    const existing = this._mounts.findIndex((m) => m.pattern === pattern)
    if (existing !== -1) {
      this._mounts.splice(existing, 1)
      log.debug('Replacing existing mount', { pattern })
    }

    // Insert in sorted order (highest specificity first)
    const entry: MountEntry = { pattern, dispatcher, specificity }

    let inserted = false
    for (let i = 0; i < this._mounts.length; i++) {
      if (specificity > this._mounts[i]!.specificity) {
        this._mounts.splice(i, 0, entry)
        inserted = true
        break
      }
    }

    if (!inserted) {
      this._mounts.push(entry)
    }

    log.debug('Mount added', { pattern, specificity, position: this._mounts.indexOf(entry) })
  }

  /**
   * Remove a mount pattern
   */
  unmount(pattern: string): boolean {
    if (pattern === 'all://') {
      this._defaultDispatcher = null
      return true
    }

    const index = this._mounts.findIndex((m) => m.pattern === pattern)
    if (index !== -1) {
      this._mounts.splice(index, 1)
      log.debug('Mount removed', { pattern })
      return true
    }
    return false
  }

  /**
   * Get dispatcher for URL
   *
   * Returns the most specific matching dispatcher, or default if no match.
   */
  getDispatcher(url: string | URL): Dispatcher | null {
    const urlStr = url instanceof URL ? url.toString() : url

    // Check mounts in order (already sorted by specificity)
    for (const { pattern, dispatcher } of this._mounts) {
      if (matchURLPattern(urlStr, pattern)) {
        log.trace('Matched mount pattern', { url: urlStr, pattern })
        return dispatcher
      }
    }

    // Fall back to default
    if (this._defaultDispatcher) {
      log.trace('Using default dispatcher', { url: urlStr })
      return this._defaultDispatcher
    }

    log.warn('No dispatcher found for URL', { url: urlStr })
    return null
  }

  /**
   * Check if router has a dispatcher for URL
   */
  hasDispatcher(url: string | URL): boolean {
    return this.getDispatcher(url) !== null
  }

  /**
   * Get all mount patterns
   */
  get patterns(): string[] {
    const patterns = this._mounts.map((m) => m.pattern)
    if (this._defaultDispatcher) {
      patterns.push('all://')
    }
    return patterns
  }

  /**
   * Get mount count
   */
  get size(): number {
    return this._mounts.length + (this._defaultDispatcher ? 1 : 0)
  }

  /**
   * Close all dispatchers
   */
  async closeAll(): Promise<void> {
    log.info('Closing all mounted dispatchers', { count: this.size })

    const closePromises: Promise<void>[] = []

    for (const { dispatcher, pattern } of this._mounts) {
      log.trace('Closing dispatcher', { pattern })
      closePromises.push(dispatcher.close())
    }

    if (this._defaultDispatcher) {
      closePromises.push(this._defaultDispatcher.close())
    }

    await Promise.all(closePromises)

    this._mounts.length = 0
    this._defaultDispatcher = null

    log.debug('All dispatchers closed')
  }

  /**
   * Create from mounts object
   */
  static fromMounts(mounts: Record<string, Dispatcher>): MountRouter {
    const router = new MountRouter()

    for (const [pattern, dispatcher] of Object.entries(mounts)) {
      router.mount(pattern, dispatcher)
    }

    return router
  }
}

/**
 * Create a MountRouter from mounts object
 */
export function createMountRouter(mounts?: Record<string, Dispatcher>): MountRouter {
  if (!mounts) {
    return new MountRouter()
  }
  return MountRouter.fromMounts(mounts)
}
