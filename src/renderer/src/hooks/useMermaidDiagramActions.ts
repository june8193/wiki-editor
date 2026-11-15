import { useCallback, useEffect, useRef, useState } from 'react'
import { logRendererError } from '../logging/rendererLogger'
import { toErrorMessage } from '../utils/toErrorMessage'

export const MERMAID_ACTION_FEEDBACK_DURATION_MS = 1500

export interface UseMermaidDiagramActionsOptions {
  code: string
}

export interface MermaidDiagramActionsState {
  canCopyCode: boolean
  isCopyingCode: boolean
  isCopiedCode: boolean
  errorMessage: string | null
  handleCopyCode: () => Promise<void>
}

const COPY_FAILED_FALLBACK_MESSAGE = 'Mermaid 코드 복사에 실패했습니다.'

/**
 * Manages clipboard copy execution, single-run concurrency, 1500ms completion
 * feedback, and sanitized inline error state for a single Mermaid block.
 */
export function useMermaidDiagramActions({
  code
}: UseMermaidDiagramActionsOptions): MermaidDiagramActionsState {
  const [isCopyingCode, setIsCopyingCode] = useState(false)
  const [isCopiedCode, setIsCopiedCode] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const isBusyRef = useRef(false)
  const feedbackTimerRef = useRef<number | null>(null)
  const executionTokenRef = useRef(0)
  const previousCodeRef = useRef(code)

  const canCopyCode = code.trim().length > 0

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      executionTokenRef.current += 1
      clearFeedbackTimer()
    }
  }, [clearFeedbackTimer])

  useEffect(() => {
    if (previousCodeRef.current === code) {
      return
    }
    previousCodeRef.current = code
    executionTokenRef.current += 1
    clearFeedbackTimer()
    isBusyRef.current = false
    setIsCopyingCode(false)
    setIsCopiedCode(false)
    setErrorMessage(null)
  }, [clearFeedbackTimer, code])

  const handleCopyCode = useCallback(async () => {
    if (isBusyRef.current || !canCopyCode) {
      return
    }

    const token = ++executionTokenRef.current
    clearFeedbackTimer()
    isBusyRef.current = true
    setIsCopyingCode(true)
    setIsCopiedCode(false)
    setErrorMessage(null)

    try {
      const copyText = window.wikiApi?.diagram?.copyText
      if (typeof copyText !== 'function') {
        throw new Error('클립보드 복사 API를 사용할 수 없습니다.')
      }

      await copyText(code)
      if (!isMountedRef.current || executionTokenRef.current !== token) {
        return
      }

      setIsCopiedCode(true)
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = null
        if (!isMountedRef.current || executionTokenRef.current !== token) {
          return
        }
        setIsCopiedCode(false)
      }, MERMAID_ACTION_FEEDBACK_DURATION_MS)
    } catch (error) {
      logRendererError('ui', 'Mermaid code copy failed', {
        data: { codeLength: code.length },
        error
      })
      if (!isMountedRef.current || executionTokenRef.current !== token) {
        return
      }
      const message = toErrorMessage(error, COPY_FAILED_FALLBACK_MESSAGE)
      setErrorMessage(message.trim().length > 0 ? message : COPY_FAILED_FALLBACK_MESSAGE)
    } finally {
      if (executionTokenRef.current === token) {
        isBusyRef.current = false
        if (isMountedRef.current) {
          setIsCopyingCode(false)
        }
      }
    }
  }, [canCopyCode, clearFeedbackTimer, code])

  return {
    canCopyCode,
    isCopyingCode,
    isCopiedCode,
    errorMessage,
    handleCopyCode
  }
}
