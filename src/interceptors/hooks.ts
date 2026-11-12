/**
 * Event hooks bridge for fetch-undici
 *
 * Converts httpx-style event hooks to Undici interceptors.
 */

import { logger } from '../logger.js'
import type { Request } from '../models/request.js'
import type { Response } from '../models/response.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Request hook function */
export type RequestHook = (request: Request) => void | Promise<void>

/** Response hook function */
export type ResponseHook = (response: Response) => void | Promise<void>

/** Event hooks configuration */
export interface EventHooksConfig {
  request?: RequestHook[]
  response?: ResponseHook[]
}

/**
 * Create hooks wrapper for request/response modification
 *
 * Note: Due to Undici's interceptor design, hooks are called at the
 * AsyncClient level rather than as Undici interceptors. This module
 * provides utilities for hook management.
 */
export class HooksManager {
  private readonly _requestHooks: RequestHook[] = []
  private readonly _responseHooks: ResponseHook[] = []

  constructor(config?: EventHooksConfig) {
    if (config?.request) {
      this._requestHooks.push(...config.request)
    }
    if (config?.response) {
      this._responseHooks.push(...config.response)
    }

    log.debug('HooksManager created', {
      requestHooks: this._requestHooks.length,
      responseHooks: this._responseHooks.length
    })
  }

  /**
   * Add request hook
   */
  addRequestHook(hook: RequestHook): void {
    this._requestHooks.push(hook)
    log.trace('Request hook added')
  }

  /**
   * Add response hook
   */
  addResponseHook(hook: ResponseHook): void {
    this._responseHooks.push(hook)
    log.trace('Response hook added')
  }

  /**
   * Remove request hook
   */
  removeRequestHook(hook: RequestHook): boolean {
    const index = this._requestHooks.indexOf(hook)
    if (index !== -1) {
      this._requestHooks.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * Remove response hook
   */
  removeResponseHook(hook: ResponseHook): boolean {
    const index = this._responseHooks.indexOf(hook)
    if (index !== -1) {
      this._responseHooks.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * Call all request hooks
   */
  async callRequestHooks(request: Request): Promise<void> {
    // Iterate a snapshot so hooks that add/remove hooks don't skip others
    for (const hook of [...this._requestHooks]) {
      try {
        await hook(request)
      } catch (err) {
        log.error('Request hook failed', { error: (err as Error).message })
        throw err
      }
    }
  }

  /**
   * Call all response hooks
   */
  async callResponseHooks(response: Response): Promise<void> {
    // Iterate a snapshot so hooks that add/remove hooks don't skip others
    for (const hook of [...this._responseHooks]) {
      try {
        await hook(response)
      } catch (err) {
        log.error('Response hook failed', { error: (err as Error).message })
        throw err
      }
    }
  }

  /**
   * Get request hooks count
   */
  get requestHookCount(): number {
    return this._requestHooks.length
  }

  /**
   * Get response hooks count
   */
  get responseHookCount(): number {
    return this._responseHooks.length
  }
}

/**
 * Create a HooksManager from configuration
 */
export function createHooksManager(config?: EventHooksConfig): HooksManager {
  return new HooksManager(config)
}
