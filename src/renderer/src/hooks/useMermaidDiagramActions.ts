import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import {
  type DiagramPngRasterAdapter,
  rasterizeMermaidSvgToPng
} from '../editor/mermaidExport'
import { logRendererError } from '../logging/rendererLogger'
import { toErrorMessage } from '../utils/toErrorMessage'

export const MERMAID_ACTION_FEEDBACK_DURATION_MS = 1500

export type MermaidActionId = 'copy-image' | 'copy-code'

export interface UseMermaidDiagramActionsOptions {
  code: string
  theme: ThemeMode
  confirmedSvg: string | null
  rasterAdapter?: DiagramPngRasterAdapter
}

export interface MermaidDiagramActionsState {
  canCopyImage: boolean
  canCopyCode: boolean
  activeAction: MermaidActionId | null
  completedAction: MermaidActionId | null
  errorMessage: string | null
  handleCopyImage: () => Promise<void>
  handleCopyCode: () => Promise<void>
}

interface ActionFailureLogContext {
  event: string
  fallbackMessage: string
  buildData: () => Record<string, unknown>
}

const COPY_CODE_FAILED_FALLBACK_MESSAGE = 'Mermaid 코드 복사에 실패했습니다.'
const COPY_IMAGE_FAILED_FALLBACK_MESSAGE = 'Mermaid 이미지 복사에 실패했습니다.'

/**
 * Coordinates Mermaid block toolbar actions (`copy-image`, `copy-code`),
 * shared busy locking, timed feedback badges, cancellation on code/theme change
 * or unmount, and sanitized failure reporting.
 */
export function useMermaidDiagramActions({
  code,
  theme,
  confirmedSvg,
  rasterAdapter
}: UseMermaidDiagramActionsOptions): MermaidDiagramActionsState {
  const [activeAction, setActiveAction] = useState<MermaidActionId | null>(null)
  const [completedAction, setCompletedAction] = useState<MermaidActionId | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const isMountedRef = useRef(true)
  const isBusyRef = useRef(false)
  const feedbackTimerRef = useRef<number | null>(null)
  const executionTokenRef = useRef(0)
  const previousContextRef = useRef({ code, theme })

  const canCopyCode = code.trim().length > 0
  const canCopyImage = canCopyCode && confirmedSvg !== null

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
    if (previousContextRef.current.code === code && previousContextRef.current.theme === theme) {
      return
    }
    previousContextRef.current = { code, theme }
    executionTokenRef.current += 1
    clearFeedbackTimer()
    isBusyRef.current = false
    setActiveAction(null)
    setCompletedAction(null)
    setErrorMessage(null)
  }, [clearFeedbackTimer, code, theme])

  const executeAction = useCallback(
    async (
      actionId: MermaidActionId,
      canExecute: boolean,
      run: (token: number) => Promise<void>,
      failureContext: ActionFailureLogContext
    ) => {
      if (isBusyRef.current || !canExecute) {
        return
      }

      const token = ++executionTokenRef.current
      clearFeedbackTimer()
      isBusyRef.current = true
      setActiveAction(actionId)
      setCompletedAction(null)
      setErrorMessage(null)

      try {
        await run(token)
        if (!isMountedRef.current || executionTokenRef.current !== token) {
          return
        }

        setCompletedAction(actionId)
        feedbackTimerRef.current = window.setTimeout(() => {
          feedbackTimerRef.current = null
          if (!isMountedRef.current || executionTokenRef.current !== token) {
            return
          }
          setCompletedAction(null)
        }, MERMAID_ACTION_FEEDBACK_DURATION_MS)
      } catch (error) {
        logRendererError('ui', failureContext.event, {
          data: failureContext.buildData(),
          error
        })
        if (!isMountedRef.current || executionTokenRef.current !== token) {
          return
        }
        const message = toErrorMessage(error, failureContext.fallbackMessage)
        setErrorMessage(message.trim().length > 0 ? message : failureContext.fallbackMessage)
      } finally {
        if (executionTokenRef.current === token) {
          isBusyRef.current = false
          if (isMountedRef.current) {
            setActiveAction(null)
          }
        }
      }
    },
    [clearFeedbackTimer]
  )

  const handleCopyImage = useCallback(async () => {
    let pngByteLength: number | undefined
    await executeAction(
      'copy-image',
      canCopyImage,
      async (token) => {
        if (confirmedSvg === null) {
          throw new Error(COPY_IMAGE_FAILED_FALLBACK_MESSAGE)
        }
        const copyImage = window.wikiApi?.diagram?.copyImage
        if (typeof copyImage !== 'function') {
          throw new Error('이미지 클립보드 복사 API를 사용할 수 없습니다.')
        }

        const pngBytes = await rasterizeMermaidSvgToPng(confirmedSvg, theme, { rasterAdapter })
        if (!isMountedRef.current || executionTokenRef.current !== token) {
          return
        }
        if (pngBytes.byteLength === 0) {
          throw new Error('렌더링된 PNG 이미지가 비어 있습니다.')
        }

        pngByteLength = pngBytes.byteLength
        await copyImage(pngBytes)
      },
      {
        event: 'Mermaid image copy failed',
        fallbackMessage: COPY_IMAGE_FAILED_FALLBACK_MESSAGE,
        buildData: () => ({
          theme,
          codeLength: code.length,
          svgLength: confirmedSvg?.length ?? 0,
          ...(pngByteLength !== undefined ? { byteLength: pngByteLength } : {})
        })
      }
    )
  }, [canCopyImage, code.length, confirmedSvg, executeAction, rasterAdapter, theme])

  const handleCopyCode = useCallback(async () => {
    await executeAction(
      'copy-code',
      canCopyCode,
      async () => {
        const copyText = window.wikiApi?.diagram?.copyText
        if (typeof copyText !== 'function') {
          throw new Error('클립보드 복사 API를 사용할 수 없습니다.')
        }

        await copyText(code)
      },
      {
        event: 'Mermaid code copy failed',
        fallbackMessage: COPY_CODE_FAILED_FALLBACK_MESSAGE,
        buildData: () => ({ codeLength: code.length })
      }
    )
  }, [canCopyCode, code, executeAction])

  return {
    canCopyImage,
    canCopyCode,
    activeAction,
    completedAction,
    errorMessage,
    handleCopyImage,
    handleCopyCode
  }
}
