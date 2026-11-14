import {
  type LogCategory,
  type LogLevel,
  type RendererLogPayload,
  sanitizeLogData,
  serializeError
} from '@shared/logging'

export interface RendererLogOptions {
  data?: Record<string, unknown>
  error?: unknown
}

export interface RendererWindowErrorTarget {
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(type: 'unhandledrejection', listener: (event: Event) => void): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(type: 'unhandledrejection', listener: (event: Event) => void): void
}

function getLogWriter(): ((payload: RendererLogPayload) => Promise<void>) | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const write = window.wikiApi?.log?.write
  return typeof write === 'function' ? write : undefined
}

/**
 * Sends a sanitized renderer log payload to Main via window.wikiApi.log, falling back to noop safely.
 */
export function logRenderer(
  level: LogLevel,
  category: LogCategory,
  message: string,
  options?: RendererLogOptions
): void {
  const write = getLogWriter()
  if (!write) {
    return
  }

  const sanitizedData = sanitizeLogData(options?.data)
  const payload: RendererLogPayload = {
    level,
    category,
    message,
    ...(sanitizedData !== undefined ? { data: sanitizedData } : {}),
    ...(options?.error !== undefined ? { error: serializeError(options.error) } : {})
  }

  try {
    void Promise.resolve(write(payload)).catch(() => undefined)
  } catch {
    // Fail-safe: renderer logging must never disrupt UI behavior.
  }
}

export function logRendererInfo(
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>
): void {
  logRenderer('info', category, message, data ? { data } : undefined)
}

export function logRendererWarn(
  category: LogCategory,
  message: string,
  options?: RendererLogOptions
): void {
  logRenderer('warn', category, message, options)
}

export function logRendererError(
  category: LogCategory,
  message: string,
  options?: RendererLogOptions
): void {
  logRenderer('error', category, message, options)
}

/**
 * Registers global window error and unhandledrejection listeners in the renderer process.
 */
export function registerRendererGlobalErrorLogging(
  target: RendererWindowErrorTarget | undefined = typeof window !== 'undefined' ? window : undefined
): () => void {
  if (!target) {
    return () => undefined
  }

  const handleWindowError = (event: ErrorEvent): void => {
    const data: Record<string, unknown> = {}
    if (event.filename) {
      data.filename = event.filename
    }
    if (event.lineno) {
      data.lineno = event.lineno
    }
    if (event.colno) {
      data.colno = event.colno
    }

    const errorPayload =
      event.error !== undefined && event.error !== null
        ? event.error
        : {
            name: 'Error',
            message: event.message || 'Unhandled error in renderer'
          }

    logRendererError('error', 'Unhandled error in renderer', {
      ...(Object.keys(data).length > 0 ? { data } : {}),
      error: errorPayload
    })
  }

  const handleUnhandledRejection = (event: Event): void => {
    const reason = (event as { reason?: unknown }).reason
    logRendererError('error', 'Unhandled promise rejection in renderer', {
      error: reason
    })
  }

  target.addEventListener('error', handleWindowError)
  target.addEventListener('unhandledrejection', handleUnhandledRejection)

  return () => {
    target.removeEventListener('error', handleWindowError)
    target.removeEventListener('unhandledrejection', handleUnhandledRejection)
  }
}
