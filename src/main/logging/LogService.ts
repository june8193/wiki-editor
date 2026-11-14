import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type LogCategory,
  type LogEntry,
  type LogLevel,
  type LogProcess,
  serializeError
} from '@shared/logging'
import { isErrnoCode } from '../fs/pathSecurity'

export const LOG_FILE_NAME = 'app.jsonl'
export const DEFAULT_MAX_LOG_FILE_SIZE_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_LOG_FILES = 3

export interface LogServiceOptions {
  maxFileSizeBytes?: number
  maxFiles?: number
}

export interface LogCallOptions {
  process?: LogProcess
  data?: Record<string, unknown>
  error?: unknown
}

export interface LogWriteInput extends LogCallOptions {
  level: LogLevel
  category: LogCategory
  message: string
}

function isValidLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.timestamp === 'string' &&
    typeof candidate.level === 'string' &&
    typeof candidate.process === 'string' &&
    typeof candidate.category === 'string' &&
    typeof candidate.message === 'string'
  )
}

function safeJsonLine(entry: LogEntry): string {
  const seen = new WeakSet<object>()
  return `${JSON.stringify(entry, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString()
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  })}\n`
}

/**
 * Serialized, fail-safe JSON Lines logger persisting Main and Renderer diagnostics.
 */
export class LogService {
  private readonly logDir: string
  private readonly logFilePath: string
  private readonly maxFileSizeBytes: number
  private readonly maxFiles: number
  private queue: Promise<void> = Promise.resolve()

  constructor(logDir: string, options: LogServiceOptions = {}) {
    this.logDir = logDir
    this.logFilePath = join(logDir, LOG_FILE_NAME)
    this.maxFileSizeBytes = Math.max(
      1,
      options.maxFileSizeBytes ?? DEFAULT_MAX_LOG_FILE_SIZE_BYTES
    )
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_LOG_FILES))
  }

  getLogDir(): string {
    return this.logDir
  }

  getLogFilePath(): string {
    return this.logFilePath
  }

  async ensureLogDir(): Promise<void> {
    await mkdir(this.logDir, { recursive: true })
  }

  write(input: LogWriteInput): Promise<void> {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: input.level,
      process: input.process ?? 'main',
      category: input.category,
      message: input.message,
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.error !== undefined ? { error: serializeError(input.error) } : {})
    }

    return this.enqueue(async () => {
      try {
        await mkdir(this.logDir, { recursive: true })
        const line = safeJsonLine(entry)
        const lineBytes = Buffer.byteLength(line, 'utf8')
        await this.rotateIfNeeded(lineBytes)
        await appendFile(this.logFilePath, line, 'utf8')
      } catch {
        // Fail-safe: logging failures must never disrupt application operations.
      }
    })
  }

  private getArchiveFilePath(index: number): string {
    return join(this.logDir, `app.${index}.jsonl`)
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let fileSize = 0
    try {
      const fileStats = await stat(this.logFilePath)
      fileSize = fileStats.size
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return
      }
      throw error
    }

    if (fileSize === 0 || fileSize + incomingBytes <= this.maxFileSizeBytes) {
      return
    }

    if (this.maxFiles <= 1) {
      await rm(this.logFilePath, { force: true })
      return
    }

    await rm(this.getArchiveFilePath(this.maxFiles - 1), { force: true })
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await this.renameIfExists(
        this.getArchiveFilePath(index),
        this.getArchiveFilePath(index + 1)
      )
    }
    await this.renameIfExists(this.logFilePath, this.getArchiveFilePath(1))
  }

  private async renameIfExists(sourcePath: string, targetPath: string): Promise<void> {
    try {
      await rename(sourcePath, targetPath)
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) {
        throw error
      }
    }
  }

  info(category: LogCategory, message: string, options?: LogCallOptions): Promise<void> {
    return this.write({ level: 'info', category, message, ...options })
  }

  warn(category: LogCategory, message: string, options?: LogCallOptions): Promise<void> {
    return this.write({ level: 'warn', category, message, ...options })
  }

  error(category: LogCategory, message: string, options?: LogCallOptions): Promise<void> {
    return this.write({ level: 'error', category, message, ...options })
  }

  flush(): Promise<void> {
    return this.queue
  }

  async readEntries(): Promise<LogEntry[]> {
    await this.flush()
    const filePaths: string[] = []
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      filePaths.push(this.getArchiveFilePath(index))
    }
    filePaths.push(this.logFilePath)

    const entries: LogEntry[] = []
    for (const filePath of filePaths) {
      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (isValidLogEntry(parsed)) {
            entries.push(parsed)
          }
        } catch {
          // Skip malformed or truncated lines safely.
        }
      }
    }
    return entries
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
