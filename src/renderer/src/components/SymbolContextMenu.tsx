import { useLayoutEffect, useRef } from 'react'
import { useDismissable } from '../hooks/useDismissable'

export interface SymbolContextMenuViewState {
  symbolName: string
  x: number
  y: number
}

interface SymbolContextMenuProps {
  menu: SymbolContextMenuViewState | null
  onGoToDefinition: () => void
  onFindReferences: () => void
  onDismiss: () => void
  onClampPosition?: (x: number, y: number) => void
}

/**
 * Right-click context menu for code identifiers in Raw code, Diff, and Snapshot viewers.
 */
export function SymbolContextMenu({
  menu,
  onGoToDefinition,
  onFindReferences,
  onDismiss,
  onClampPosition
}: SymbolContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismissable(menu !== null, menuRef, onDismiss)

  useLayoutEffect(() => {
    if (!menu || !menuRef.current || !onClampPosition) return
    const rect = menuRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
    const clampedX = Math.min(Math.max(margin, menu.x), maxX)
    const clampedY = Math.min(Math.max(margin, menu.y), maxY)
    if (clampedX !== menu.x || clampedY !== menu.y) {
      onClampPosition(clampedX, clampedY)
    }
  }, [menu, onClampPosition])

  if (!menu) {
    return null
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${menu.symbolName} 심볼 메뉴`}
      data-testid="symbol-context-menu"
      className="tree-context-menu"
      style={{ top: menu.y, left: menu.x }}
    >
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={onGoToDefinition}
      >
        정의로 이동
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={onFindReferences}
      >
        레퍼런스 찾기
      </button>
    </div>
  )
}
