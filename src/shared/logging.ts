export const LOG_LEVELS = ['info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
export type LogProcess = 'main' | 'renderer'
export const LOG_CATEGORIES = ['app', 'ipc', 'git', 'workspace', 'config', 'ui', 'error'] as const
export type LogCategory = (typeof LOG_CATEGORIES)[number]

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string | number
  signal?: string
  stderr?: string
  stdout?: string
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  process: LogProcess
  category: LogCategory
  message: string
  data?: Record<string, unknown>
  error?: SerializedError
}

export interface RendererLogPayload {
  level: LogLevel
  category: LogCategory
  message: string
  data?: Record<string, unknown>
  error?: SerializedError
}

const SENSITIVE_LOG_DATA_KEYS = new Set([
  'content',
  'initialContent',
  'savedContent',
  'nextContent',
  'raw',
  'rawContent'
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (value instanceof Error) {
    return serializeError(value)
  }
  if (typeof value !== 'object') {
    return undefined
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const sanitized = sanitizeLogValue(item, seen)
        return sanitized === undefined ? null : sanitized
      })
    }
    if (isPlainRecord(value)) {
      return sanitizePlainRecord(value, seen)
    }
    return serializeError(value)
  } finally {
    seen.delete(value)
  }
}

function sanitizePlainRecord(
  record: Record<string, unknown>,
  seen: WeakSet<object>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  const hasExplicitContentLength = typeof record.contentLength === 'number'

  for (const [key, rawValue] of Object.entries(record)) {
    if (SENSITIVE_LOG_DATA_KEYS.has(key)) {
      if (
        typeof rawValue === 'string' &&
        !hasExplicitContentLength &&
        sanitized.contentLength === undefined
      ) {
        sanitized.contentLength = rawValue.length
      }
      continue
    }
    const nextValue = sanitizeLogValue(rawValue, seen)
    if (nextValue !== undefined) {
      sanitized[key] = nextValue
    }
  }
  return sanitized
}

/**
 * Strips sensitive document/config text fields from log metadata while preserving length metadata.
 */
export function sanitizeLogData(data: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(data)) {
    return undefined
  }
  const seen = new WeakSet<object>([data])
  const sanitized = sanitizePlainRecord(data, seen)
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

interface ErrorLikeRecord {
  name?: unknown
  message?: unknown
  stack?: unknown
  code?: unknown
  signal?: unknown
  stderr?: unknown
  stdout?: unknown
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOptionalCode(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function buildSerializedError(
  name: string,
  message: string,
  source: ErrorLikeRecord
): SerializedError {
  const serialized: SerializedError = { name, message }
  const stack = readOptionalNonEmptyString(source.stack)
  const code = readOptionalCode(source.code)
  const signal = readOptionalNonEmptyString(source.signal)
  const stderr = readOptionalNonEmptyString(source.stderr)
  const stdout = readOptionalNonEmptyString(source.stdout)
  if (stack !== undefined) serialized.stack = stack
  if (code !== undefined) serialized.code = code
  if (signal !== undefined) serialized.signal = signal
  if (stderr !== undefined) serialized.stderr = stderr
  if (stdout !== undefined) serialized.stdout = stdout
  return serialized
}

function formatFallbackMessage(error: object): string {
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Converts any thrown value or error-like payload into a plain SerializedError object.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return buildSerializedError(
      error.name || 'Error',
      error.message || 'Unknown error',
      error as Error & ErrorLikeRecord
    )
  }

  if (typeof error === 'object' && error !== null) {
    const raw = error as ErrorLikeRecord
    return buildSerializedError(
      readOptionalNonEmptyString(raw.name) ?? 'Error',
      readOptionalNonEmptyString(raw.message) ?? formatFallbackMessage(error),
      raw
    )
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : String(error)
  }
}
