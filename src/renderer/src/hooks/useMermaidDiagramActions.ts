import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import type { DiagramExportFormat } from '@shared/ipc'
import {
  buildMermaidExportFileName,
  normalizeMermaidSvg,
  rasterizeMermaidSvgToPng
} from '../editor/mermaidExport'
import { logRendererError } from '../logging/rendererLogger'
import { toErrorMessage } from '@shared/errors'
import type { WikiApi } from '@shared/ipc'
import { useOptionalWikiApi } from './useWikiApi'

export const MERMAID_ACTION_FEEDBACK_DURATION_MS = 1500

export type MermaidActionId = 'copy-image' | 'copy-code' | 'save-png' | 'save-svg'

export interface UseMermaidDiagramActionsOptions {
  code: string
  theme: ThemeMode
  confirmedSvg: string | null
  documentTitle?: string
}

export interface MermaidDiagramActionsState {
  canExport: boolean
  canCopyCode: boolean
  activeAction: MermaidActionId | null
  completedAction: MermaidActionId | null
  errorMessage: string | null
  handleCopyImage: () => Promise<void>
  handleCopyCode: () => Promise<void>
  handleSavePng: () => Promise<void>
  handleSaveSvg: () => Promise<void>
}

interface ActionFailureLogContext {
  event: string
  fallbackMessage: string
  buildData: () => Record<string, unknown>
}

const COPY_CODE_FAILED_FALLBACK_MESSAGE = 'Mermaid 코드 복사에 실패했습니다.'
const COPY_IMAGE_FAILED_FALLBACK_MESSAGE = 'Mermaid 이미지 복사에 실패했습니다.'
const SAVE_PNG_FAILED_FALLBACK_MESSAGE = 'Mermaid PNG 파일 저장에 실패했습니다.'
const SAVE_SVG_FAILED_FALLBACK_MESSAGE = 'Mermaid SVG 파일 저장에 실패했습니다.'

function resolveSaveFileSender(
  diagramApi: WikiApi['diagram'] | undefined,
  format: DiagramExportFormat,
  documentTitle?: string
): (data: Uint8Array | string) => Promise<boolean> {
  const saveFile = diagramApi?.saveFile
  if (typeof saveFile !== 'function') {
    throw new Error('다이어그램 파일 저장 API를 사용할 수 없습니다.')
  }
  return async (data) => {
    const result = await saveFile({
      format,
      suggestedName: buildMermaidExportFileName(documentTitle, format),
      data
    })
    return !result.canceled
  }
}

/**
 * Coordinates Mermaid block toolbar actions (`copy-image`, `copy-code`, `save-png`, `save-svg`),
 * shared busy locking, timed feedback badges, cancellation on code/theme change
 * or unmount, and sanitized failure reporting.
 */
export function useMermaidDiagramActions({
  code,
  theme,
  confirmedSvg,
  documentTitle
}: UseMermaidDiagramActionsOptions): MermaidDiagramActionsState {
  const contextWikiApi = useOptionalWikiApi()
  const [activeAction, setActiveAction] = useState<MermaidActionId | null>(null)
  const [completedAction, setCompletedAction] = useState<MermaidActionId | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const isMountedRef = useRef(true)
  const isBusyRef = useRef(false)
  const feedbackTimerRef = useRef<number | null>(null)
  const executionTokenRef = useRef(0)
  const previousContextRef = useRef({ code, theme })

  const canCopyCode = code.trim().length > 0
  const canExport = canCopyCode && confirmedSvg !== null

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
      run: (token: number) => Promise<boolean | void>,
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
        const completed = await run(token)
        if (!isMountedRef.current || executionTokenRef.current !== token || completed === false) {
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

  const executePngExportAction = useCallback(
    async ({
      actionId,
      event,
      fallbackMessage,
      extraLogData,
      resolveSender
    }: {
      actionId: 'copy-image' | 'save-png'
      event: string
      fallbackMessage: string
      extraLogData?: Record<string, unknown>
      resolveSender: () => (pngBytes: Uint8Array) => Promise<boolean | void>
    }) => {
      let pngByteLength: number | undefined
      await executeAction(
        actionId,
        canExport,
        async (token) => {
          if (confirmedSvg === null) {
            throw new Error(fallbackMessage)
          }
          const sendPng = resolveSender()

          const pngBytes = await rasterizeMermaidSvgToPng(confirmedSvg, theme)
          if (!isMountedRef.current || executionTokenRef.current !== token) {
            return false
          }
          if (pngBytes.byteLength === 0) {
            throw new Error('렌더링된 PNG 이미지가 비어 있습니다.')
          }

          pngByteLength = pngBytes.byteLength
          return await sendPng(pngBytes)
        },
        {
          event,
          fallbackMessage,
          buildData: () => ({
            ...extraLogData,
            theme,
            codeLength: code.length,
            svgLength: confirmedSvg?.length ?? 0,
            ...(pngByteLength !== undefined ? { byteLength: pngByteLength } : {})
          })
        }
      )
    },
    [canExport, code.length, confirmedSvg, executeAction, theme]
  )

  const handleCopyImage = useCallback(
    () =>
      executePngExportAction({
        actionId: 'copy-image',
        event: 'Mermaid image copy failed',
        fallbackMessage: COPY_IMAGE_FAILED_FALLBACK_MESSAGE,
        resolveSender: () => {
          const copyImage = (contextWikiApi ?? window.wikiApi)?.diagram?.copyImage
          if (typeof copyImage !== 'function') {
            throw new Error('이미지 클립보드 복사 API를 사용할 수 없습니다.')
          }
          return copyImage
        }
      }),
    [contextWikiApi, executePngExportAction]
  )

  const handleSavePng = useCallback(
    () =>
      executePngExportAction({
        actionId: 'save-png',
        event: 'Mermaid PNG save failed',
        fallbackMessage: SAVE_PNG_FAILED_FALLBACK_MESSAGE,
        extraLogData: { format: 'png' },
        resolveSender: () =>
          resolveSaveFileSender((contextWikiApi ?? window.wikiApi)?.diagram, 'png', documentTitle)
      }),
    [contextWikiApi, documentTitle, executePngExportAction]
  )

  const handleSaveSvg = useCallback(async () => {
    let normalizedSvgLength: number | undefined
    await executeAction(
      'save-svg',
      canExport,
      async () => {
        if (confirmedSvg === null) {
          throw new Error(SAVE_SVG_FAILED_FALLBACK_MESSAGE)
        }
        const sendSvg = resolveSaveFileSender(
          (contextWikiApi ?? window.wikiApi)?.diagram,
          'svg',
          documentTitle
        )
        const normalized = normalizeMermaidSvg(confirmedSvg, theme)
        normalizedSvgLength = normalized.svg.length
        return await sendSvg(normalized.svg)
      },
      {
        event: 'Mermaid SVG save failed',
        fallbackMessage: SAVE_SVG_FAILED_FALLBACK_MESSAGE,
        buildData: () => ({
          format: 'svg',
          theme,
          codeLength: code.length,
          svgLength: normalizedSvgLength ?? confirmedSvg?.length ?? 0
        })
      }
    )
  }, [canExport, code.length, confirmedSvg, contextWikiApi, documentTitle, executeAction, theme])

  const handleCopyCode = useCallback(async () => {
    await executeAction(
      'copy-code',
      canCopyCode,
      async () => {
        const copyText = (contextWikiApi ?? window.wikiApi)?.diagram?.copyText
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
  }, [canCopyCode, code, contextWikiApi, executeAction])

  return {
    canExport,
    canCopyCode,
    activeAction,
    completedAction,
    errorMessage,
    handleCopyImage,
    handleCopyCode,
    handleSavePng,
    handleSaveSvg
  }
}
