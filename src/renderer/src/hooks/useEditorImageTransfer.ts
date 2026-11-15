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
}

export const ImageTransferContext = createContext<ImageTransferContextValue>({})

export interface TextInsertionRange {
  from: number
  to: number
}

export interface EditorImageTransferOptions<TTarget> {
  documentPath: string | null
  enableImageInsertion: boolean
  draggingWorkspaceImagePath?: string | null
  onClearDraggingWorkspaceImage?: () => void
  onReportError?: (title: string, error: unknown) => void
  ingestImage?: ImageIngestor
  getPathForFile?: (file: File) => string
  onTabDrag?: () => boolean
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
  const mergedOptions = {
    ...options,
    draggingWorkspaceImagePath:
      options.draggingWorkspaceImagePath !== undefined
        ? options.draggingWorkspaceImagePath
        : (context.draggingWorkspaceImagePath ?? null),
    onClearDraggingWorkspaceImage:
      options.onClearDraggingWorkspaceImage ?? context.clearDraggingWorkspaceImage,
    onReportError: options.onReportError ?? context.reportImageError
  }

  const optionsRef = useRef(mergedOptions)
  optionsRef.current = mergedOptions

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
      const current = optionsRef.current
      void resolvePendingImageSources(targetDocumentPath, sources, current.ingestImage)
        .then((results) => {
          const latest = optionsRef.current
          if (!isMountedRef.current || results.length === 0) {
            return
          }
          const target = latest.getTarget()
          if (!target || !latest.enableImageInsertion || latest.documentPath !== targetDocumentPath) {
            return
          }
          latest.insertImages(target, results, range)
        })
        .catch((error: unknown) => {
          if (isMountedRef.current) {
            optionsRef.current.onReportError?.('이미지 삽입에 실패했습니다.', error)
          }
        })
    },
    []
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent, targetOverride?: TTarget | null): boolean => {
      const current = optionsRef.current
      if (!current.enableImageInsertion || !current.documentPath) {
        return false
      }

      const sources = extractClipboardImageSources(event.clipboardData, {
        getPathForFile: current.getPathForFile
      })
      if (sources.length === 0) {
        return false
      }

      const target = targetOverride ?? current.getTarget()
      if (!target) {
        return false
      }

      event.preventDefault()
      runImageInsertion(current.documentPath, sources, current.getSelectionRange(target))
      return true
    },
    [runImageInsertion]
  )

  const handleDragOver = useCallback((event: DragEvent): boolean => {
    if (event.defaultPrevented) {
      return false
    }
    const current = optionsRef.current
    const inspected = inspectDropTransfer(event.dataTransfer, {
      getPathForFile: current.getPathForFile,
      draggingWorkspaceImagePath: current.draggingWorkspaceImagePath
    })
    if (inspected.isTabDrag) {
      return current.onTabDrag ? current.onTabDrag() : false
    }
    if (!inspected.isWorkspaceOrFileDrag) {
      return false
    }

    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect =
        current.enableImageInsertion && current.documentPath ? 'copy' : 'none'
    }
    return true
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent, targetOverride?: TTarget | null): boolean => {
      if (event.defaultPrevented) {
        return false
      }
      const current = optionsRef.current
      const inspected = inspectDropTransfer(event.dataTransfer, {
        getPathForFile: current.getPathForFile,
        draggingWorkspaceImagePath: current.draggingWorkspaceImagePath
      })
      if (inspected.isTabDrag) {
        return current.onTabDrag ? current.onTabDrag() : false
      }
      if (!inspected.isWorkspaceOrFileDrag) {
        return false
      }

      event.preventDefault()
      event.stopPropagation()
      current.onClearDraggingWorkspaceImage?.()

      if (
        !current.enableImageInsertion ||
        !current.documentPath ||
        inspected.sources.length === 0
      ) {
        return true
      }

      const target = targetOverride ?? current.getTarget()
      if (!target) {
        return true
      }

      let dropPos: number | null = null
      if (
        typeof document.elementFromPoint === 'function' &&
        (event.clientX > 0 || event.clientY > 0)
      ) {
        try {
          dropPos = current.posAtCoords(target, event.clientX, event.clientY)
        } catch {
          dropPos = null
        }
      }

      const targetRange =
        dropPos !== null ? { from: dropPos, to: dropPos } : current.getSelectionRange(target)

      runImageInsertion(current.documentPath, inspected.sources, targetRange)
      return true
    },
    [runImageInsertion]
  )

  return { handlePaste, handleDragOver, handleDrop }
}
