import { useCallback, useState } from 'react'
import { logRendererError } from '../logging/rendererLogger'

/**
 * Manages the window's top error banner message and records structured renderer error logs.
 */
export function useErrorBanner() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const reportErrorBanner = useCallback((message: string | null, error?: unknown): void => {
    setErrorMessage(message)
    if (message) {
      logRendererError('ui', 'Error banner displayed', {
        data: { errorMessage: message },
        ...(error !== undefined ? { error } : {})
      })
    }
  }, [])

  return {
    errorMessage,
    reportErrorBanner
  }
}
