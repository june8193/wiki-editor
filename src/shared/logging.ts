export type LogLevel = 'info' | 'warn' | 'error'
export type LogProcess = 'main' | 'renderer'
export type LogCategory = 'app' | 'ipc' | 'git' | 'workspace' | 'config' | 'ui' | 'error'

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
