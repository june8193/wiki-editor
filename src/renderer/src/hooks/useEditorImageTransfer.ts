import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import type { WorkspaceImageIngestResult } from '@shared/assets'
import {
  extractClipboardImageSources,
  inspectDropTransfer,
  resolvePendingImageSources,
  type ImageIngestor,
  type PendingImageSource
} from '../editor/imageIngestion'

export interface ImageTransferContextValue {
  draggingWorkspaceImagePath?: string | null
  clearDraggingWorkspaceImage?: () => void
  reportImageError?: (title: string, error: unknown) => void
  ingestImage?: ImageIngestor
  getPathForFile?: (file: File) => string
}

export const ImageTransferContext = createContext<ImageTransferContextValue>({})

export interface TextInsertionRange {
  from: number
  to: number
}

export interface EditorImageTransferOptions<TTarget> {
  documentPath: string | null
  enableImageInsertion: boolean
  /** Return true on tab drags to prevent ProseMirror's native drop behavior without calling preventDefault(). */
  suppressNativeTabDrop?: boolean
  getTarget: () => TTarget | null
  posAtCoords: (target: TTarget, clientX: number, clientY: number) => number | null
  getSelectionRange: (target: TTarget) => TextInsertionRange
  insertImages: (
    target: TTarget,
    results: readonly WorkspaceImageIngestResult[],
    range: TextInsertionRange
  ) => void
}

export interface EditorImageTransferHandlers<TTarget> {
  handlePaste: (event: ClipboardEvent, targetOverride?: TTarget | null) => boolean
  handleDragOver: (event: DragEvent) => boolean
  handleDrop: (event: DragEvent, targetOverride?: TTarget | null) => boolean
}

/**
 * Unifies clipboard paste and OS/workspace-tree image drag-and-drop handling across Raw and WYSIWYG editors.
 */
export function useEditorImageTransfer<TTarget>(
  options: EditorImageTransferOptions<TTarget>
): EditorImageTransferHandlers<TTarget> {
  const context = useContext(ImageTransferContext)
  const optionsRef = useRef({ options, context })
  optionsRef.current = { options, context }

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const runImageInsertion = useCallback(
    (
      targetDocumentPath: string,
      sources: readonly PendingImageSource[],
      range: TextInsertionRange
    ): void => {
      const { context: ctx } = optionsRef.current
      void resolvePendingImageSources(targetDocumentPath, sources, ctx.ingestImage)
        .then((results) => {
          const { options: latestOpts } = optionsRef.current
          if (!isMountedRef.current || results.length === 0) {
            return
          }
          const target = latestOpts.getTarget()
          if (
            !target ||
            !latestOpts.enableImageInsertion ||
            latestOpts.documentPath !== targetDocumentPath
          ) {
            return
          }
          latestOpts.insertImages(target, results, range)
        })
        .catch((error: unknown) => {
          if (isMountedRef.current) {
            optionsRef.current.context.reportImageError?.('이미지 삽입에 실패했습니다.', error)
          }
        })
    },
    []
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent, targetOverride?: TTarget | null): boolean => {
      const { options: opts, context: ctx } = optionsRef.current
      if (!opts.enableImageInsertion || !opts.documentPath) {
        return false
      }

      const sources = extractClipboardImageSources(event.clipboardData, {
        getPathForFile: ctx.getPathForFile
      })
      if (sources.length === 0) {
        return false
      }

      const target = targetOverride ?? opts.getTarget()
      if (!target) {
        return false
      }

      event.preventDefault()
      runImageInsertion(opts.documentPath, sources, opts.getSelectionRange(target))
      return true
    },
    [runImageInsertion]
  )

  const handleDragOver = useCallback((event: DragEvent): boolean => {
    if (event.defaultPrevented) {
      return false
    }
    const { options: opts, context: ctx } = optionsRef.current
    const inspected = inspectDropTransfer(event.dataTransfer, {
      getPathForFile: ctx.getPathForFile,
      draggingWorkspaceImagePath: ctx.draggingWorkspaceImagePath ?? null
    })
    if (inspected.isTabDrag) {
      return Boolean(opts.suppressNativeTabDrop)
    }
    if (!inspected.isWorkspaceOrFileDrag) {
      return false
    }

    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect =
        opts.enableImageInsertion && opts.documentPath ? 'copy' : 'none'
    }
    return true
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent, targetOverride?: TTarget | null): boolean => {
      if (event.defaultPrevented) {
        return false
      }
      const { options: opts, context: ctx } = optionsRef.current
      const inspected = inspectDropTransfer(event.dataTransfer, {
        getPathForFile: ctx.getPathForFile,
        draggingWorkspaceImagePath: ctx.draggingWorkspaceImagePath ?? null
      })
      if (inspected.isTabDrag) {
        return Boolean(opts.suppressNativeTabDrop)
      }
      if (!inspected.isWorkspaceOrFileDrag) {
        return false
      }

      event.preventDefault()
      event.stopPropagation()
      ctx.clearDraggingWorkspaceImage?.()

      if (!opts.enableImageInsertion || !opts.documentPath || inspected.sources.length === 0) {
        return true
      }

      const target = targetOverride ?? opts.getTarget()
      if (!target) {
        return true
      }

      let dropPos: number | null = null
      if (
        typeof document.elementFromPoint === 'function' &&
        (event.clientX > 0 || event.clientY > 0)
      ) {
        try {
          dropPos = opts.posAtCoords(target, event.clientX, event.clientY)
        } catch {
          dropPos = null
        }
      }

      const targetRange =
        dropPos !== null ? { from: dropPos, to: dropPos } : opts.getSelectionRange(target)

      runImageInsertion(opts.documentPath, inspected.sources, targetRange)
      return true
    },
    [runImageInsertion]
  )

  return { handlePaste, handleDragOver, handleDrop }
}
