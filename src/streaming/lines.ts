/**
 * Line streaming utilities for fetch-undici
 */

import type { Readable } from 'node:stream'
import { logger } from '../logger.js'
import { iterText } from './text.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Split decoded text chunks into lines
 *
 * Lines are separated by LF; a CR immediately before the LF (CRLF) is stripped,
 * as is a CR at the very end of the input. A lone CR inside a line is kept.
 */
export async function* linesFromText(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''

  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split('\n')

    // Keep last partial line in buffer (split always returns at least one element)
    buffer = lines.pop()!

    for (const line of lines) {
      yield stripTrailingCR(line)
    }
  }

  // Yield remaining content
  const rest = stripTrailingCR(buffer)
  if (rest) {
    yield rest
  }
}

/**
 * Remove a single trailing carriage return
 */
function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Iterate over readable stream line by line
 *
 * Handles both LF and CRLF line endings (line terminators are not included).
 */
export async function* iterLines(
  stream: Readable,
  encoding: BufferEncoding = 'utf-8'
): AsyncGenerator<string> {
  log.trace('Starting line iteration', { encoding })

  let lineCount = 0

  for await (const line of linesFromText(iterText(stream, encoding))) {
    lineCount++
    yield line
  }

  log.trace('Line iteration complete', { lineCount })
}

/**
 * Iterate over NDJSON (Newline Delimited JSON) stream
 */
export async function* iterNDJSON<T = unknown>(
  stream: Readable,
  encoding: BufferEncoding = 'utf-8'
): AsyncGenerator<T> {
  log.trace('Starting NDJSON iteration', { encoding })

  let objectCount = 0

  for await (const line of iterLines(stream, encoding)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      objectCount++
      yield JSON.parse(trimmed) as T
    } catch (err) {
      log.warn('Failed to parse NDJSON line', {
        lineNumber: objectCount,
        error: (err as Error).message
      })
      throw err
    }
  }

  log.trace('NDJSON iteration complete', { objectCount })
}

/**
 * Collect stream into array of lines
 */
export async function collectLines(
  stream: Readable,
  encoding: BufferEncoding = 'utf-8'
): Promise<string[]> {
  const lines: string[] = []

  for await (const line of iterLines(stream, encoding)) {
    lines.push(line)
  }

  log.trace('Collected lines', { count: lines.length })

  return lines
}

/**
 * Split an SSE stream into lines per the SSE spec
 *
 * CRLF, LF and lone CR are all line terminators, and a leading BOM is skipped.
 * An unterminated trailing line is discarded (it can never complete an event).
 */
async function* iterSSELines(stream: Readable): AsyncGenerator<string> {
  let buffer = ''
  let first = true

  for await (const chunk of iterText(stream, 'utf-8')) {
    buffer += chunk
    if (first && buffer.length > 0) {
      first = false
      if (buffer.startsWith('\uFEFF')) {
        buffer = buffer.slice(1)
      }
    }

    let start = 0
    for (const match of buffer.matchAll(/\r\n|\r|\n/g)) {
      // A CR at the end of the buffer may be the first half of a CRLF split across chunks
      if (match[0] === '\r' && match.index === buffer.length - 1) {
        break
      }
      yield buffer.slice(start, match.index)
      start = match.index + match[0].length
    }
    buffer = buffer.slice(start)
  }

  // A buffered trailing CR terminates its line at EOF
  if (buffer.endsWith('\r')) {
    yield buffer.slice(0, -1)
  }
}

/**
 * Iterate over Server-Sent Events stream
 *
 * Follows the SSE spec: CRLF/LF/CR line endings, `retry` only when it is all ASCII
 * digits, and an event not terminated by a blank line before EOF is discarded.
 */
export async function* iterSSE(stream: Readable): AsyncGenerator<{
  event?: string
  data: string
  id?: string
  retry?: number
}> {
  log.trace('Starting SSE iteration')

  let currentEvent: { event?: string; data: string[]; id?: string; retry?: number } = {
    data: []
  }

  for await (const line of iterSSELines(stream)) {
    if (line === '') {
      // Empty line = dispatch event
      if (currentEvent.data.length > 0) {
        yield {
          event: currentEvent.event,
          data: currentEvent.data.join('\n'),
          id: currentEvent.id,
          retry: currentEvent.retry
        }
      }
      currentEvent = { data: [] }
      continue
    }

    // Parse SSE field
    const colonIndex = line.indexOf(':')

    if (colonIndex === 0) {
      // Comment (starts with :)
      continue
    }

    let field: string
    let value: string

    if (colonIndex === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colonIndex)
      value = line.slice(colonIndex + 1)
      // Remove single leading space if present
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
    }

    switch (field) {
      case 'event':
        currentEvent.event = value
        break
      case 'data':
        currentEvent.data.push(value)
        break
      case 'id':
        currentEvent.id = value
        break
      case 'retry':
        if (/^[0-9]+$/.test(value)) {
          currentEvent.retry = Number.parseInt(value, 10)
        }
        break
    }
  }

  if (currentEvent.data.length > 0) {
    log.debug('Discarding unterminated SSE event at end of stream')
  }

  log.trace('SSE iteration complete')
}
