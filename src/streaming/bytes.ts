/**
 * Byte streaming utilities for fetch-undici
 */

import { Readable } from 'node:stream'
import { logger } from '../logger.js'

const log = logger.create('fetch-undici', import.meta.url)

/**
 * Validate an optional chunk size. undefined and 0 both mean "no splitting".
 *
 * @returns the chunk size to split on, or undefined for no splitting
 * @throws RangeError if chunkSize is negative or not an integer
 */
export function normalizeChunkSize(chunkSize: number | undefined): number | undefined {
  if (chunkSize === undefined || chunkSize === 0) {
    return undefined
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 0) {
    throw new RangeError(`chunkSize must be a non-negative integer, got ${chunkSize}`)
  }
  return chunkSize
}

/**
 * Iterate over readable stream as byte chunks
 *
 * Chunks larger than chunkSize are split; smaller chunks are yielded as-is.
 *
 * @throws RangeError if chunkSize is negative or not an integer
 */
export async function* iterBytes(
  stream: Readable,
  chunkSize?: number
): AsyncGenerator<Buffer> {
  const size = normalizeChunkSize(chunkSize)
  log.trace('Starting byte iteration', { chunkSize: size })

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    if (size !== undefined && buffer.length > size) {
      // Split into smaller chunks (subarray clamps the end index)
      for (let i = 0; i < buffer.length; i += size) {
        yield buffer.subarray(i, i + size)
      }
    } else {
      yield buffer
    }
  }

  log.trace('Byte iteration complete')
}

/**
 * Collect stream into buffer
 */
export async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const result = Buffer.concat(chunks)
  log.trace('Collected bytes', { size: result.length })

  return result
}

/**
 * Create a passthrough stream that reports progress
 */
export function createProgressStream(
  onProgress: (bytesRead: number, totalBytes?: number) => void,
  totalBytes?: number
): {
  stream: Readable
  feed: (chunk: Buffer) => void
  end: () => void
} {
  let bytesRead = 0
  let ended = false

  const stream = new Readable({
    read() {
      // Chunks will be pushed via feed()
    }
  })

  return {
    stream,
    feed: (chunk: Buffer) => {
      if (ended) return
      bytesRead += chunk.length
      stream.push(chunk)
      onProgress(bytesRead, totalBytes)
    },
    end: () => {
      if (ended) return
      ended = true
      stream.push(null)
      log.trace('Progress stream ended', { bytesRead, totalBytes })
    }
  }
}
