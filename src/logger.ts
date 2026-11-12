/**
 * Logger Infrastructure for fetch-undici
 *
 * Provides structured logging with verbose output for defensive programming.
 * Usage: const log = logger.create('fetch-undici', import.meta.url)
 */

/** Log levels in order of verbosity */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** Log level numeric values for comparison */
const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5
}

/** Structure of a log entry */
export interface LogEntry {
  level: LogLevel
  timestamp: string
  package: string
  file: string
  message: string
  context?: Record<string, unknown>
}

/** Options for logger creation */
export interface LoggerOptions {
  level?: LogLevel
  transport?: (entry: LogEntry) => void
  json?: boolean
  redact?: string[]
}

/** Logger interface with level methods */
export interface Logger {
  trace(message: string, context?: Record<string, unknown>): void
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  child(context: Record<string, unknown>): Logger
  setLevel(level: LogLevel): void
  getLevel(): LogLevel
}

/**
 * Default keys to redact from logs
 *
 * Keys are matched by whole word tokens, not substrings: a context key is
 * split into words (camelCase, snake_case, kebab-case, spaces) and is redacted
 * when its words contain a redact key's words in order (a trailing plural "s"
 * is accepted), or when the key with separators removed equals the redact key
 * with separators removed. So `AccessToken`, `USER_PASSWORD`, `x-api-key`,
 * `APIKEY` and `Proxy-Authorization` are redacted, while `author` is not.
 */
const DEFAULT_REDACT_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'auth',
  'credential',
  'private',
  'cookie',
  'set-cookie'
]

/** Placeholder for redacted values */
const REDACTED = '[REDACTED]'

/** Placeholder for circular references */
const CIRCULAR = '[Circular]'

/**
 * Split a key into lower-case word tokens
 *
 * @example tokenizeKey('privateKeyPem') // ['private', 'key', 'pem']
 */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Pre-processed redact key */
interface RedactMatcher {
  tokens: string[]
  joined: string
}

/**
 * Build matchers from redact keys
 */
function buildMatchers(redactKeys: string[]): RedactMatcher[] {
  return redactKeys
    .map((k) => {
      const tokens = tokenizeKey(k)
      return { tokens, joined: tokens.join('') }
    })
    .filter((m) => m.tokens.length > 0)
}

/**
 * Check whether a key should be redacted (whole-token match)
 */
function isSensitiveKey(key: string, matchers: RedactMatcher[]): boolean {
  const tokens = tokenizeKey(key)
  const joined = tokens.join('')
  return matchers.some((m) => {
    if (joined === m.joined || joined === `${m.joined}s`) {
      return true
    }
    const last = m.tokens.length - 1
    for (let start = 0; start + last < tokens.length; start++) {
      let matched = true
      for (let j = 0; j <= last; j++) {
        const token = tokens[start + j]!
        const want = m.tokens[j]!
        if (token !== want && !(j === last && token === `${want}s`)) {
          matched = false
          break
        }
      }
      if (matched) {
        return true
      }
    }
    return false
  })
}

/**
 * Convert a value into a log-safe, acyclic structure with secrets redacted
 *
 * - Arrays and plain objects are recursed into (secrets inside arrays are redacted)
 * - Circular references become '[Circular]'
 * - Date -> ISO string (or 'Invalid Date'); Error -> { name, message }
 * - URL -> string with any password masked
 * - Buffer / typed arrays -> '[Buffer N bytes]' style summary
 * - Objects with toJSON() use its result
 * - Primitives are returned as-is
 */
function sanitizeValue(value: unknown, matchers: RedactMatcher[], seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    const name = Buffer.isBuffer(value) ? 'Buffer' : value.constructor.name
    return `[${name} ${value.byteLength} bytes]`
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }

  if (value instanceof URL) {
    if (value.password) {
      const masked = new URL(value.href)
      masked.password = '****'
      return masked.href
    }
    return value.href
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }

  if (seen.has(value)) {
    return CIRCULAR
  }
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, matchers, seen))
    }

    const withToJSON = value as { toJSON?: unknown }
    if (typeof withToJSON.toJSON === 'function') {
      return sanitizeValue((withToJSON.toJSON as () => unknown)(), matchers, seen)
    }

    return redactObject(value as Record<string, unknown>, matchers, seen)
  } finally {
    // Only ancestors count as cycles; shared (non-circular) references are fine
    seen.delete(value)
  }
}

/**
 * Redact sensitive keys of an object and sanitize its values
 */
function redactObject(
  obj: Record<string, unknown>,
  matchers: RedactMatcher[],
  seen: WeakSet<object>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    result[key] = isSensitiveKey(key, matchers) ? REDACTED : sanitizeValue(value, matchers, seen)
  }

  return result
}

/**
 * Redact sensitive values from context object
 */
function redactSensitive(
  obj: Record<string, unknown>,
  matchers: RedactMatcher[]
): Record<string, unknown> {
  return redactObject(obj, matchers, new WeakSet<object>())
}

/**
 * Extract filename from import.meta.url or string path
 */
function extractFilename(filename: string | URL): string {
  if (filename instanceof URL) {
    const pathname = filename.pathname
    return pathname.split('/').pop() || 'unknown'
  }

  if (filename.startsWith('file://')) {
    try {
      const url = new URL(filename)
      return url.pathname.split('/').pop() || 'unknown'
    } catch {
      return filename.split('/').pop() || 'unknown'
    }
  }

  return filename.split('/').pop() || 'unknown'
}

/**
 * Get log level from environment variable
 */
function getEnvLogLevel(): LogLevel {
  const envLevel = process.env['LOG_LEVEL']?.toLowerCase()
  // Object.hasOwn so inherited keys like 'constructor' are not accepted
  if (envLevel && Object.hasOwn(LOG_LEVELS, envLevel)) {
    return envLevel as LogLevel
  }
  return 'info'
}

/**
 * Default console transport
 */
function defaultTransport(entry: LogEntry, json: boolean): void {
  const output = json ? JSON.stringify(entry) : formatLogEntry(entry)

  switch (entry.level) {
    case 'trace':
    case 'debug':
      // eslint-disable-next-line no-console
      console.debug(output)
      break
    case 'info':
      // eslint-disable-next-line no-console
      console.info(output)
      break
    case 'warn':
      // eslint-disable-next-line no-console
      console.warn(output)
      break
    case 'error':
      // eslint-disable-next-line no-console
      console.error(output)
      break
  }
}

/**
 * Format log entry for human-readable output
 */
function formatLogEntry(entry: LogEntry): string {
  const { timestamp, level, package: pkg, file, message, context } = entry
  const levelStr = level.toUpperCase().padEnd(5)
  const prefix = `${timestamp} [${levelStr}] ${pkg}/${file}:`

  if (context && Object.keys(context).length > 0) {
    return `${prefix} ${message} ${JSON.stringify(context)}`
  }

  return `${prefix} ${message}`
}

/**
 * Create a logger instance
 */
function createLoggerInstance(
  packageName: string,
  filename: string | URL,
  options: LoggerOptions = {},
  parentContext: Record<string, unknown> = {}
): Logger {
  const file = extractFilename(filename)
  let currentLevel = options.level ?? getEnvLogLevel()
  const transport = options.transport
  const json = options.json ?? (process.env['LOG_FORMAT'] === 'json')
  const redactMatchers = buildMatchers([...DEFAULT_REDACT_KEYS, ...(options.redact ?? [])])

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]
  }

  function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!shouldLog(level)) return

    const mergedContext = { ...parentContext, ...context }
    const redactedContext =
      Object.keys(mergedContext).length > 0 ? redactSensitive(mergedContext, redactMatchers) : undefined

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      package: packageName,
      file,
      message,
      context: redactedContext
    }

    if (transport) {
      transport(entry)
    } else {
      defaultTransport(entry, json)
    }
  }

  return {
    trace: (message, context) => log('trace', message, context),
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),

    child(context: Record<string, unknown>): Logger {
      return createLoggerInstance(packageName, filename, options, {
        ...parentContext,
        ...context
      })
    },

    setLevel(level: LogLevel): void {
      currentLevel = level
    },

    getLevel(): LogLevel {
      return currentLevel
    }
  }
}

/**
 * Logger factory
 *
 * @param packageName - Name of the package (e.g., 'fetch-undici')
 * @param filename - Module filename, typically import.meta.url
 * @param options - Optional logger configuration
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * import { logger } from './logger.js'
 * const log = logger.create('fetch-undici', import.meta.url)
 *
 * log.debug('Request starting', { method: 'GET', url: '/users' })
 * log.info('Client created', { baseUrl: 'https://api.example.com' })
 * log.error('Request failed', { error: err.message })
 * ```
 */
export function create(
  packageName: string,
  filename: string | URL,
  options?: LoggerOptions
): Logger {
  return createLoggerInstance(packageName, filename, options)
}

/** Logger factory object */
export const logger = {
  create,
  LOG_LEVELS,
  getEnvLogLevel
}

export default logger
