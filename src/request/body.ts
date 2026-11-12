/**
 * Request body handling for fetch-undici
 *
 * Handles JSON, form data, files, and raw content.
 */

import type { Readable } from 'node:stream'
import { FormData as UndiciFormData } from 'undici'
import { logger } from '../logger.js'
import { Headers, type HeadersInit } from '../models/headers.js'
import { RequestOptionsError } from '../exceptions/base.js'

const log = logger.create('fetch-undici', import.meta.url)

/** File upload types */
export interface FileUpload {
  content: Buffer | Blob | Readable | string
  filename?: string
  contentType?: string
}

/** Body options for requests */
export interface BodyOptions {
  /** JSON body (auto-serialized) */
  json?: unknown
  /** Form data (URL-encoded or FormData) */
  data?: Record<string, unknown> | FormData | URLSearchParams
  /** Raw content */
  content?: string | Buffer | Uint8Array | Readable
  /** File uploads (multipart) */
  files?: Record<string, FileUpload | Buffer | string>
}

/** Processed body result (multipart bodies are undici FormData so undici can send them) */
export interface ProcessedBody {
  body: string | Buffer | Readable | UndiciFormData | null
  headers: Headers
}

/**
 * Process body options into Undici-compatible body
 */
export function processBody(options: BodyOptions, existingHeaders?: HeadersInit): ProcessedBody {
  const headers = new Headers(existingHeaders)
  let bodyCount = 0

  // Count provided body options
  if (options.json !== undefined) bodyCount++
  if (options.data !== undefined) bodyCount++
  if (options.content !== undefined) bodyCount++
  if (options.files !== undefined) bodyCount++

  // Check for conflicts (only data + files may be combined, like httpx)
  const dataWithFiles = bodyCount === 2 && options.files !== undefined && options.data !== undefined
  if (bodyCount > 1 && !dataWithFiles) {
    throw new RequestOptionsError(
      options.files !== undefined
        ? 'Cannot combine files with json or content. Only data may be sent with files.'
        : 'Cannot specify multiple body options (json, data, content). Use only one.'
    )
  }

  // Handle JSON
  if (options.json !== undefined) {
    log.trace('Processing JSON body')
    const jsonBody = JSON.stringify(options.json)
    setDefaultContentType(headers, 'application/json')
    return { body: jsonBody, headers }
  }

  // Handle files (multipart)
  if (options.files) {
    log.trace('Processing file uploads')
    const formData = buildMultipartFormData(options.files, options.data)
    // FormData sets its own Content-Type with boundary
    return { body: formData, headers }
  }

  // Handle form data
  if (options.data !== undefined) {
    log.trace('Processing form data')

    if (options.data instanceof UndiciFormData) {
      return { body: options.data, headers }
    }

    if (options.data instanceof FormData) {
      // The global FormData cannot be sent by the installed undici; copy it
      return { body: copyFormData(options.data), headers }
    }

    if (options.data instanceof URLSearchParams) {
      setDefaultContentType(headers, 'application/x-www-form-urlencoded')
      return { body: options.data.toString(), headers }
    }

    // Plain object - convert to URLSearchParams
    const params = new URLSearchParams()
    for (const [key, value] of formFields(options.data)) {
      params.append(key, value)
    }
    setDefaultContentType(headers, 'application/x-www-form-urlencoded')
    return { body: params.toString(), headers }
  }

  // Handle raw content
  if (options.content !== undefined) {
    log.trace('Processing raw content')

    if (typeof options.content === 'string') {
      setDefaultContentType(headers, 'text/plain')
      return { body: options.content, headers }
    }

    // Buffer and Uint8Array (Buffer is a Uint8Array subclass) are copied
    setDefaultContentType(headers, 'application/octet-stream')
    if (options.content instanceof Uint8Array) {
      return { body: Buffer.from(options.content), headers }
    }

    // Stream
    return { body: options.content, headers }
  }

  return { body: null, headers }
}

/**
 * Set Content-Type unless the caller already provided one (httpx keeps user headers)
 */
function setDefaultContentType(headers: Headers, contentType: string): void {
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', contentType)
  }
}

/**
 * Flatten a plain data object into string form fields
 *
 * Array values become repeated fields; null/undefined values (top-level or
 * inside arrays) are skipped.
 */
function* formFields(data: Record<string, unknown>): Generator<[string, string]> {
  for (const [key, value] of Object.entries(data)) {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      if (v !== undefined && v !== null) {
        yield [key, String(v)]
      }
    }
  }
}

/**
 * Copy FormData entries (global or undici) into a new undici FormData
 */
function copyFormData(source: FormData | UndiciFormData, target = new UndiciFormData()): UndiciFormData {
  for (const [key, value] of source.entries()) {
    if (typeof value === 'string') {
      target.append(key, value)
    } else {
      target.append(key, value, value.name)
    }
  }
  return target
}

/**
 * Build multipart FormData from files and optional data
 */
function buildMultipartFormData(
  files: Record<string, FileUpload | Buffer | string>,
  data?: Record<string, unknown> | FormData | URLSearchParams
): UndiciFormData {
  const formData = new UndiciFormData()

  // Add regular data fields first
  if (data) {
    if (data instanceof FormData || data instanceof UndiciFormData) {
      copyFormData(data, formData)
    } else if (data instanceof URLSearchParams) {
      for (const [key, value] of data.entries()) {
        formData.append(key, value)
      }
    } else {
      for (const [key, value] of formFields(data)) {
        formData.append(key, value)
      }
    }
  }

  // Add files
  for (const [fieldName, file] of Object.entries(files)) {
    if (Buffer.isBuffer(file) || typeof file === 'string') {
      // Simple file
      formData.append(fieldName, new Blob([file]), fieldName)
    } else {
      // FileUpload object
      const { content, filename, contentType } = file

      let blob: Blob
      if (content instanceof Blob) {
        // Re-wrap only when an explicit contentType overrides the blob's own type
        blob = contentType !== undefined ? new Blob([content], { type: contentType }) : content
      } else if (Buffer.isBuffer(content) || typeof content === 'string') {
        blob = new Blob([content], { type: contentType })
      } else {
        // Stream - need to consume it
        throw new RequestOptionsError('Streaming file uploads are not directly supported. Buffer the content first.')
      }

      formData.append(fieldName, blob, filename || fieldName)
    }
  }

  log.trace('Built multipart form data', {
    fileCount: Object.keys(files).length,
    hasData: !!data
  })

  return formData
}

/**
 * Check if body options contain a body
 */
export function hasBodyOptions(options: BodyOptions): boolean {
  return (
    options.json !== undefined ||
    options.data !== undefined ||
    options.content !== undefined ||
    options.files !== undefined
  )
}
