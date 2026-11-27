import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'

export type TitleBarMenuItem =
  | {
      kind: 'item'
      id: string
      label: string
      shortcut?: string
      onSelect: () => void
    }
  | {
      kind: 'separator'
      id: string
    }

export interface TitleBarMenuGroup {
  id: string
  label: string
  items: readonly TitleBarMenuItem[]
}

export interface TitleBarProps {
  title: string
  menus?: readonly TitleBarMenuGroup[]
  isMenuDisabled?: boolean
  isMacOS?: boolean
}

type ActionMenuItem = Extract<TitleBarMenuItem, { kind: 'item' }>

function detectMacOS(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')
}

/**
 * Custom 32px draggable title bar integrating optional left application dropdown menus (Main Window),
 * centered window title with version, and space on the right for Windows native titleBarOverlay controls.
 */
export function TitleBar({ title, menus, isMenuDisabled = false, isMacOS }: TitleBarProps) {
  const resolvedIsMacOS = isMacOS ?? detectMacOS()
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [focusedItemIndex, setFocusedItemIndex] = useState<number>(-1)
  const menuBarRef = useRef<HTMLElement | null>(null)
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const openMenu = menus?.find((menu) => menu.id === openMenuId) ?? null
  const actionItems: ActionMenuItem[] = openMenu
    ? openMenu.items.filter((item): item is ActionMenuItem => item.kind === 'item')
    : []

  const closeMenu = useCallback((restoreTriggerId?: string): void => {
    setOpenMenuId(null)
    setFocusedItemIndex(-1)
    if (restoreTriggerId) {
      triggerRefs.current[restoreTriggerId]?.focus()
    }
  }, [])

  useEffect(() => {
    if (isMenuDisabled && openMenuId !== null) {
      closeMenu()
    }
  }, [closeMenu, isMenuDisabled, openMenuId])

  useEffect(() => {
    if (openMenuId === null) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (
        menuBarRef.current &&
        event.target instanceof Node &&
        menuBarRef.current.contains(event.target)
      ) {
        return
      }
      closeMenu()
    }

    const handleWindowBlur = (): void => {
      closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [closeMenu, openMenuId])

  useEffect(() => {
    if (openMenuId === null || focusedItemIndex < 0) return
    itemRefs.current[focusedItemIndex]?.focus()
  }, [focusedItemIndex, openMenuId])

  const handleMenuBarKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!menus || menus.length === 0 || isMenuDisabled) return

    if (event.key === 'Escape') {
      if (openMenuId !== null) {
        event.preventDefault()
        closeMenu(openMenuId)
      }
      return
    }

    if (openMenuId === null) return

    const currentMenuIndex = menus.findIndex((menu) => menu.id === openMenuId)
    if (currentMenuIndex < 0) return

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const nextMenu = menus[(currentMenuIndex + delta + menus.length) % menus.length]
      setOpenMenuId(nextMenu.id)
      setFocusedItemIndex(-1)
      triggerRefs.current[nextMenu.id]?.focus()
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (actionItems.length === 0) return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex =
        focusedItemIndex < 0
          ? event.key === 'ArrowDown'
            ? 0
            : actionItems.length - 1
          : (focusedItemIndex + delta + actionItems.length) % actionItems.length
      setFocusedItemIndex(nextIndex)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      if (focusedItemIndex >= 0 && focusedItemIndex < actionItems.length) {
        event.preventDefault()
        const selectedItem = actionItems[focusedItemIndex]
        closeMenu()
        selectedItem.onSelect()
      }
    }
  }

  return (
    <div className={`app-titlebar${resolvedIsMacOS ? ' is-macos' : ''}`}>
      <div className="app-titlebar-title" title={title}>
        <span className="app-titlebar-title-text">{title}</span>
      </div>
      {menus && menus.length > 0 && (
        <nav
          ref={menuBarRef}
          className="app-titlebar-menus"
          role="menubar"
          aria-label="애플리케이션 메뉴"
          onKeyDown={handleMenuBarKeyDown}
        >
          {menus.map((menu) => {
            const isOpen = openMenuId === menu.id && !isMenuDisabled
            let actionIndex = -1
            return (
              <div key={menu.id} className="app-titlebar-menu-group">
                <button
                  ref={(node) => {
                    triggerRefs.current[menu.id] = node
                  }}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  disabled={isMenuDisabled}
                  className={`app-titlebar-menu-trigger${isOpen ? ' is-open' : ''}`}
                  onClick={() => {
                    if (isMenuDisabled) return
                    setOpenMenuId((prev) => (prev === menu.id ? null : menu.id))
                    setFocusedItemIndex(-1)
                  }}
                  onMouseEnter={() => {
                    if (isMenuDisabled || openMenuId === null || openMenuId === menu.id) return
                    setOpenMenuId(menu.id)
                    setFocusedItemIndex(-1)
                  }}
                >
                  {menu.label}
                </button>
                {isOpen && (
                  <div className="app-titlebar-dropdown" role="menu" aria-label={menu.label}>
                    {menu.items.map((item) => {
                      if (item.kind === 'separator') {
                        return (
                          <div
                            key={item.id}
                            className="app-titlebar-dropdown-separator"
                            role="separator"
                          />
                        )
                      }
                      actionIndex += 1
                      const currentActionIndex = actionIndex
                      return (
                        <button
                          key={item.id}
                          ref={(node) => {
                            itemRefs.current[currentActionIndex] = node
                          }}
                          type="button"
                          role="menuitem"
                          className="app-titlebar-dropdown-item"
                          onMouseEnter={() => setFocusedItemIndex(currentActionIndex)}
                          onClick={() => {
                            closeMenu()
                            item.onSelect()
                          }}
                        >
                          <span>{item.label}</span>
                          {item.shortcut && (
                            <span className="app-titlebar-dropdown-shortcut">{item.shortcut}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      )}
    </div>
  )
}
