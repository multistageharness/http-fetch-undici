/**
 * CLI Context for fetch-undici SDK
 *
 * Provides CLI-specific utilities for command-line HTTP tools.
 */

import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { logger, type Logger } from '../logger.js'
import { AsyncClient, type AsyncClientOptions, type RequestOptions } from '../client/index.js'
import { Response } from '../models/response.js'

const defaultLog = logger.create('fetch-undici', import.meta.url)

/** Progress callback */
export type ProgressCallback = (bytesDownloaded: number, totalBytes?: number) => void

/** CLI context options */
export interface CLIContextOptions extends AsyncClientOptions {
  /** Enable verbose output */
  verbose?: boolean
  /** Progress callback */
  onProgress?: ProgressCallback
}

/** Download result */
export interface DownloadResult {
  success: boolean
  statusCode: number
  bytesDownloaded: number
  outputPath?: string
  error?: string
  exitCode: number
}

/**
 * CLI Context for HTTP operations
 *
 * Provides utilities for CLI tools including progress reporting,
 * file downloads, and exit code mapping.
 *
 * @example
 * ```typescript
 * const cli = new CLIContext({
 *   baseUrl: 'https://api.example.com',
 *   verbose: true
 * })
 *
 * const result = await cli.download('/files/data.zip', {
 *   output: './downloads/data.zip',
 *   onProgress: (downloaded, total) => {
 *     process.stdout.write(`\rDownloading: ${(downloaded/total*100).toFixed(1)}%`)
 *   }
 * })
 *
 * process.exit(result.exitCode)
 * ```
 */
export class CLIContext {
  private readonly _client: AsyncClient
  private readonly _verbose: boolean
  private readonly _log: Logger
  private _defaultProgress?: ProgressCallback

  constructor(options?: CLIContextOptions) {
    this._verbose = options?.verbose ?? false
    this._log = defaultLog
    this._defaultProgress = options?.onProgress

    this._client = new AsyncClient({
      ...options,
      followRedirects: options?.followRedirects ?? true
    })

    if (this._verbose) {
      this._log.info('CLIContext initialized')
    }
  }

  /**
   * Make request and print response
   */
  async request(method: string, url: string, options?: RequestOptions): Promise<{
    response: Response
    exitCode: number
  }> {
    try {
      const response = await this._client.request(method, url, options)
      const exitCode = this._statusToExitCode(response.statusCode)

      if (this._verbose) {
        this._log.info('Response received', {
          statusCode: response.statusCode,
          exitCode
        })
      }

      return { response, exitCode }
    } catch (err) {
      this._log.error('Request failed', { error: (err as Error).message })
      return {
        response: new Response({ statusCode: 0 }),
        exitCode: 1
      }
    }
  }

  /**
   * Download file with progress
   */
  async download(url: string, options: {
    output: string
    method?: string
    onProgress?: ProgressCallback
  } & RequestOptions): Promise<DownloadResult> {
    const { output, method = 'GET', onProgress, ...requestOptions } = options
    const progressCallback = onProgress ?? this._defaultProgress

    try {
      const response = await this._client.request(method, url, requestOptions)

      if (!response.ok) {
        await response.aclose()
        return {
          success: false,
          statusCode: response.statusCode,
          bytesDownloaded: 0,
          error: `HTTP ${response.statusCode}`,
          exitCode: this._statusToExitCode(response.statusCode)
        }
      }

      // Get total bytes if available
      const totalBytes = response.contentLength ?? undefined
      let bytesDownloaded = 0

      // Stream to file with backpressure; resolves once the file is flushed
      try {
        await pipeline(
          async function* () {
            for await (const chunk of response.aiterBytes()) {
              bytesDownloaded += chunk.length
              if (progressCallback) {
                progressCallback(bytesDownloaded, totalBytes)
              }
              yield chunk
            }
          },
          createWriteStream(output)
        )
      } catch (err) {
        await response.aclose()
        this._log.error('Download failed', { error: (err as Error).message })
        return {
          success: false,
          statusCode: response.statusCode,
          bytesDownloaded,
          error: (err as Error).message,
          exitCode: 1
        }
      }

      if (this._verbose) {
        this._log.info('Download complete', {
          output,
          bytesDownloaded,
          totalBytes
        })
      }

      return {
        success: true,
        statusCode: response.statusCode,
        bytesDownloaded,
        outputPath: output,
        exitCode: 0
      }
    } catch (err) {
      this._log.error('Download failed', { error: (err as Error).message })
      return {
        success: false,
        statusCode: 0,
        bytesDownloaded: 0,
        error: (err as Error).message,
        exitCode: 1
      }
    }
  }

  /**
   * Stream response to stdout
   */
  async *streamToStdout(method: string, url: string, options?: RequestOptions): AsyncGenerator<string> {
    const response = await this._client.request(method, url, options)

    for await (const text of response.aiterText()) {
      process.stdout.write(text)
      yield text
    }
  }

  /**
   * Close CLI context
   */
  async close(): Promise<void> {
    await this._client.close()
  }

  /**
   * Map HTTP status to exit code
   */
  private _statusToExitCode(statusCode: number): number {
    if (statusCode === 0) return 1 // Network error
    if (statusCode >= 200 && statusCode < 300) return 0 // Success
    if (statusCode >= 400 && statusCode < 500) return 4 // Client error
    if (statusCode >= 500) return 5 // Server error
    return 0 // Default success for redirects, etc.
  }
}

/**
 * Create CLI context
 */
export function createCLIContext(options?: CLIContextOptions): CLIContext {
  return new CLIContext(options)
}
