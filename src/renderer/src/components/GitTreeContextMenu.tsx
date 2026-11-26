import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useDismissable } from '../hooks/useDismissable'
import { formatGitRepoCopyPath, type GitCopyPathMode } from '../utils/gitFilePresentation'

export interface GitTreeContextMenuTarget {
  kind: 'file' | 'dir'
  repoRelativePath: string
  x: number
  y: number
  onOpenPinnedDiff?: () => void
}

export interface GitTreeContextMenuProps {
  target: GitTreeContextMenuTarget | null
  onClose: () => void
  onCopyPath: (repoRelativePath: string, mode: GitCopyPathMode) => void
  onClampPosition: (x: number, y: number) => void
}

export interface UseGitTreeContextMenuOptions {
  workspaceRootPath?: string | null
  repoRoot?: string | null
  onCopyPath?: (repoRelativePath: string, mode: GitCopyPathMode) => void
}

/**
 * Manages open/close, clamping, workspace-reset, copy fallback, and file/dir trigger handlers
 * for a Git/Compare tree context menu.
 */
export function useGitTreeContextMenu({
  workspaceRootPath = null,
  repoRoot = null,
  onCopyPath
}: UseGitTreeContextMenuOptions = {}) {
  const [target, setTarget] = useState<GitTreeContextMenuTarget | null>(null)

  const closeMenu = useCallback(() => setTarget(null), [])

  useEffect(() => {
    closeMenu()
  }, [closeMenu, workspaceRootPath])

  const handleCopyPath = useCallback(
    (repoRelativePath: string, mode: GitCopyPathMode): void => {
      if (onCopyPath) {
        onCopyPath(repoRelativePath, mode)
        return
      }
      const formatted = formatGitRepoCopyPath(
        repoRelativePath,
        mode,
        repoRoot,
        workspaceRootPath
      )
      void navigator.clipboard?.writeText(formatted)
    },
    [onCopyPath, repoRoot, workspaceRootPath]
  )

  const openFileMenu = useCallback(
    (event: ReactMouseEvent, repoRelativePath: string, onOpenPinnedDiff: () => void): void => {
      event.preventDefault()
      event.stopPropagation()
      setTarget({
        kind: 'file',
        repoRelativePath,
        x: event.clientX,
        y: event.clientY,
        onOpenPinnedDiff
      })
    },
    []
  )

  const openDirMenu = useCallback((event: ReactMouseEvent, repoRelativePath: string): void => {
    event.preventDefault()
    event.stopPropagation()
    setTarget({
      kind: 'dir',
      repoRelativePath,
      x: event.clientX,
      y: event.clientY
    })
  }, [])

  const clampPosition = useCallback((x: number, y: number): void => {
    setTarget((prev) => (prev ? { ...prev, x, y } : null))
  }, [])

  return {
    target,
    openFileMenu,
    openDirMenu,
    closeMenu,
    clampPosition,
    handleCopyPath
  }
}

/**
 * Shared right-click context menu for Compare folder tree and Git Changes file/folder rows.
 */
export function GitTreeContextMenu({
  target,
  onClose,
  onCopyPath,
  onClampPosition
}: GitTreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useDismissable(target !== null, menuRef, onClose)

  useLayoutEffect(() => {
    if (!target || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
    const clampedX = Math.min(Math.max(margin, target.x), maxX)
    const clampedY = Math.min(Math.max(margin, target.y), maxY)

    if (clampedX !== target.x || clampedY !== target.y) {
      onClampPosition(clampedX, clampedY)
    }
  }, [onClampPosition, target])

  if (!target) {
    return null
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      className="tree-context-menu"
      style={{ top: target.y, left: target.x }}
    >
      {target.kind === 'file' && target.onOpenPinnedDiff && (
        <>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              const openPinnedDiff = target.onOpenPinnedDiff
              onClose()
              openPinnedDiff?.()
            }}
          >
            새 탭에서 Diff 열기
          </button>
          <div role="separator" className="context-menu-separator" />
        </>
      )}
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={() => {
          const path = target.repoRelativePath
          onClose()
          onCopyPath(path, 'relative')
        }}
      >
        상대 경로 복사
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={() => {
          const path = target.repoRelativePath
          onClose()
          onCopyPath(path, 'absolute')
        }}
      >
        절대 경로 복사
      </button>
    </div>
  )
}
