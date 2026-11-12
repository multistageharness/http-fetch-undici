/**
 * Text streaming utilities for fetch-undici
 */

import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '../logger.js'
import { iterBytes } from './bytes.js'

const log = logger.create('fetch-undici', import.meta.url)

/** Incremental decoder that handles multibyte sequences split across chunks */
export interface ChunkDecoder {
  /** Decode a chunk, buffering any incomplete trailing sequence */
  write(chunk: Buffer): string
  /** Flush buffered bytes (incomplete sequences become U+FFFD) */
  end(): string
}

/**
 * Create an incremental decoder for an encoding label
 *
 * Node BufferEncoding names (utf8, utf16le, ucs2, latin1, binary, ...) are decoded
 * with StringDecoder; other WHATWG/IANA labels (iso-8859-1, windows-1252, shift_jis, ...)
 * with TextDecoder. Unknown labels fall back to utf-8.
 */
export function createDecoder(encoding: string): ChunkDecoder {
  if (Buffer.isEncoding(encoding)) {
    const decoder = new StringDecoder(encoding)
    return {
      write: (chunk) => decoder.write(chunk),
      end: () => decoder.end()
    }
  }

  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(encoding)
  } catch {
    log.warn('Unknown text encoding, falling back to utf-8', { encoding })
    return createDecoder('utf-8')
  }
  return {
    write: (chunk) => decoder.decode(chunk, { stream: true }),
    end: () => decoder.decode()
  }
}

/**
 * Iterate over readable stream as text chunks
 */
export async function* iterText(
  stream: Readable,
  encoding: BufferEncoding = 'utf-8'
): AsyncGenerator<string> {
  log.trace('Starting text iteration', { encoding })

  const decoder = createDecoder(encoding)

  for await (const chunk of iterBytes(stream)) {
    yield decoder.write(chunk)
  }

  // Flush remaining
  const final = decoder.end()
  if (final) {
    yield final
  }

  log.trace('Text iteration complete')
}

/**
 * Collect stream into string
 */
export async function collectText(
  stream: Readable,
  encoding: BufferEncoding = 'utf-8'
): Promise<string> {
  const chunks: string[] = []

  for await (const chunk of iterText(stream, encoding)) {
    chunks.push(chunk)
  }

  const result = chunks.join('')
  log.trace('Collected text', { length: result.length })

  return result
}
