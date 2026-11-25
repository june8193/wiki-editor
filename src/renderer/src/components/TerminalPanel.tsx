import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import type { ThemeMode } from '@shared/config'
import type { TerminalShellProfile } from '@shared/terminal'
import { getTerminalXtermTheme } from '../terminal/terminalTheme'
import { resolveTerminalLinkTarget } from '../terminal/terminalLinks'
import {
  createXtermInstance as defaultCreateXtermInstance,
  type XtermInstance,
  type XtermInstanceFactory
} from '../terminal/xtermAdapter'
import type { TerminalHeightBounds } from '../utils/terminalHeight'
import { TerminalResizer } from './TerminalResizer'

export interface TerminalTabState {
  id: string
  profileId: string
  title: string
  isRunning: boolean
  exitCode: number | null
}

export interface TerminalPanelProps {
  isOpen: boolean
  height: number
  heightBounds: TerminalHeightBounds
  theme: ThemeMode
  tabs: readonly TerminalTabState[]
  activeTabId: string | null
  profiles?: readonly TerminalShellProfile[]
  workspaceRootPath?: string | null
  errorMessage: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewTerminal: (profileId?: string) => void
  onCollapse: () => void
  onResizeHeight: (nextHeight: number) => void
  onWriteSession: (sessionId: string, data: string) => void
  onResizeSession: (sessionId: string, cols: number, rows: number) => void
  subscribeSessionData: (listener: (sessionId: string, data: string) => void) => () => void
  onOpenExternalUrl?: (url: string) => void
  onOpenWorkspaceFile?: (filePath: string, lineNumber?: number, column?: number) => void
  readClipboardText?: () => Promise<string>
  writeClipboardText?: (text: string) => Promise<void>
  createXtermInstance?: XtermInstanceFactory
}

function defaultReadClipboardText(): Promise<string> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function') {
    return navigator.clipboard.readText()
  }
  return Promise.resolve('')
}

function defaultWriteClipboardText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    return navigator.clipboard.writeText(text)
  }
  return Promise.resolve()
}

/**
 * Bottom integrated terminal panel for the main window's central workspace column.
 * Keeps mounted xterm instances alive while collapsed so running processes and scrollback persist.
 */
export function TerminalPanel({
  isOpen,
  height,
  heightBounds,
  theme,
  tabs,
  activeTabId,
  profiles = [],
  workspaceRootPath = null,
  errorMessage,
  onSelectTab,
  onCloseTab,
  onNewTerminal,
  onCollapse,
  onResizeHeight,
  onWriteSession,
  onResizeSession,
  subscribeSessionData,
  onOpenExternalUrl,
  onOpenWorkspaceFile,
  readClipboardText = defaultReadClipboardText,
  writeClipboardText = defaultWriteClipboardText,
  createXtermInstance = defaultCreateXtermInstance
}: TerminalPanelProps) {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const xtermTheme = useMemo(() => getTerminalXtermTheme(theme), [theme])
  const xtermThemeRef = useRef(xtermTheme)
  xtermThemeRef.current = xtermTheme

  const callbacksRef = useRef({
    onWriteSession,
    onResizeSession,
    onOpenExternalUrl,
    onOpenWorkspaceFile,
    workspaceRootPath,
    readClipboardText,
    writeClipboardText
  })
  callbacksRef.current = {
    onWriteSession,
    onResizeSession,
    onOpenExternalUrl,
    onOpenWorkspaceFile,
    workspaceRootPath,
    readClipboardText,
    writeClipboardText
  }

  const instancesRef = useRef<Map<string, XtermInstance>>(new Map())
  const containersRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map())
  const lastSizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map())
  const handledKeyEventsRef = useRef<WeakSet<KeyboardEvent>>(new WeakSet())

  const pasteClipboardToSession = useCallback((sessionId: string): void => {
    void callbacksRef.current
      .readClipboardText()
      .then((text) => {
        if (!text) return
        const instance = instancesRef.current.get(sessionId)
        if (instance) {
          instance.paste(text)
        } else {
          callbacksRef.current.onWriteSession(sessionId, text)
        }
      })
      .catch(() => undefined)
  }, [])

  const handleTerminalKeyEvent = useCallback(
    (sessionId: string, event: KeyboardEvent): boolean => {
      if (handledKeyEventsRef.current.has(event)) {
        return true
      }
      handledKeyEventsRef.current.add(event)

      if (event.type !== 'keydown') {
        return true
      }

      const hasPrimaryModifier = (event.ctrlKey || event.metaKey) && !event.altKey
      if (!hasPrimaryModifier) {
        return true
      }

      const key = event.key.toLowerCase()
      if (key === 'c') {
        const instance = instancesRef.current.get(sessionId)
        if (instance?.hasSelection()) {
          const selectedText = instance.getSelection()
          if (selectedText) {
            void callbacksRef.current.writeClipboardText(selectedText).catch(() => undefined)
          }
          instance.clearSelection()
          return false
        }
        return !event.shiftKey
      }

      if (key === 'v') {
        pasteClipboardToSession(sessionId)
        return false
      }

      return true
    },
    [pasteClipboardToSession]
  )

  const handleActivateLink = useCallback((rawText: string, event: MouseEvent): void => {
    if (!event.ctrlKey && !event.metaKey) {
      return
    }
    const target = resolveTerminalLinkTarget(rawText, callbacksRef.current.workspaceRootPath)
    if (!target) return
    if (target.kind === 'external') {
      callbacksRef.current.onOpenExternalUrl?.(target.url)
      return
    }
    callbacksRef.current.onOpenWorkspaceFile?.(target.targetPath, target.line, target.column)
  }, [])

  const syncSessionSize = useCallback((sessionId: string, cols: number, rows: number): void => {
    const prev = lastSizeRef.current.get(sessionId)
    if (prev && prev.cols === cols && prev.rows === rows) return
    lastSizeRef.current.set(sessionId, { cols, rows })
    callbacksRef.current.onResizeSession(sessionId, cols, rows)
  }, [])

  const fitAndSyncSession = useCallback(
    (sessionId: string): void => {
      const instance = instancesRef.current.get(sessionId)
      if (!instance) return
      const measured = instance.fit()
      if (!measured) return
      syncSessionSize(sessionId, measured.cols, measured.rows)
    },
    [syncSessionSize]
  )

  // Subscribe to PTY output and route to live xterm instances (buffering until mounted).
  useEffect(() => {
    return subscribeSessionData((sessionId, data) => {
      const instance = instancesRef.current.get(sessionId)
      if (instance) {
        instance.write(data)
        return
      }
      const queued = pendingOutputRef.current.get(sessionId) ?? []
      queued.push(data)
      pendingOutputRef.current.set(sessionId, queued)
    })
  }, [subscribeSessionData])

  // Mount new xterm instances and dispose removed ones.
  useEffect(() => {
    const liveIds = new Set(tabs.map((tab) => tab.id))

    for (const [sessionId, instance] of instancesRef.current.entries()) {
      if (!liveIds.has(sessionId)) {
        instance.dispose()
        instancesRef.current.delete(sessionId)
        containersRef.current.delete(sessionId)
        pendingOutputRef.current.delete(sessionId)
        lastSizeRef.current.delete(sessionId)
      }
    }

    for (const tab of tabs) {
      if (instancesRef.current.has(tab.id)) continue
      const container = containersRef.current.get(tab.id)
      if (!container) continue

      const instance = createXtermInstance({
        sessionId: tab.id,
        theme: xtermThemeRef.current,
        onData: (data) => {
          callbacksRef.current.onWriteSession(tab.id, data)
        },
        onResize: (cols, rows) => {
          syncSessionSize(tab.id, cols, rows)
        },
        onKeyEvent: (event) => handleTerminalKeyEvent(tab.id, event),
        onActivateLink: handleActivateLink
      })

      instancesRef.current.set(tab.id, instance)
      instance.open(container)

      const queued = pendingOutputRef.current.get(tab.id)
      if (queued && queued.length > 0) {
        for (const chunk of queued) {
          instance.write(chunk)
        }
        pendingOutputRef.current.delete(tab.id)
      }

      if (isOpen && tab.id === activeTabId) {
        fitAndSyncSession(tab.id)
      }
    }
  }, [tabs, isOpen, activeTabId, createXtermInstance, fitAndSyncSession])

  // Dispose all xterm instances on unmount.
  useEffect(() => {
    const instances = instancesRef.current
    const containers = containersRef.current
    const pendingOutput = pendingOutputRef.current
    const lastSize = lastSizeRef.current
    return () => {
      for (const instance of instances.values()) {
        instance.dispose()
      }
      instances.clear()
      containers.clear()
      pendingOutput.clear()
      lastSize.clear()
    }
  }, [])

  // Sync xterm theme palette when application theme changes.
  useEffect(() => {
    for (const instance of instancesRef.current.values()) {
      instance.setTheme(xtermTheme)
    }
  }, [xtermTheme])

  // Re-fit active terminal when panel opens, resizes, or active tab changes.
  useEffect(() => {
    if (!isOpen || !activeTabId) return
    fitAndSyncSession(activeTabId)
    instancesRef.current.get(activeTabId)?.focus()
  }, [isOpen, activeTabId, height, fitAndSyncSession])

  // Close profile dropdown on outside click or Escape, or when panel collapses.
  useEffect(() => {
    if (!isOpen) {
      setIsProfileMenuOpen(false)
      return
    }
    if (!isProfileMenuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setIsProfileMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsProfileMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, isProfileMenuOpen])

  if (!isOpen && tabs.length === 0) {
    return null
  }

  return (
    <section
      className={`terminal-panel${isOpen ? '' : ' is-collapsed'}`}
      aria-label="터미널 패널"
      aria-hidden={!isOpen || undefined}
      style={isOpen ? { height: `${height}px` } : undefined}
    >
      <TerminalResizer height={height} bounds={heightBounds} onResize={onResizeHeight} />

      <div className="terminal-panel-header">
        <div className="terminal-panel-title">
          <TerminalIcon size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>터미널</span>
        </div>

        <div className="terminal-tab-list" role="tablist" aria-label="터미널 탭 목록">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                className={`terminal-tab${isActive ? ' is-active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelectTab(tab.id)
                  }
                }}
              >
                <span
                  className={`terminal-tab-status ${tab.isRunning ? 'is-running' : 'is-exited'}`}
                  aria-hidden="true"
                />
                <span className="terminal-tab-label">{tab.title}</span>
                {!tab.isRunning && (
                  <span className="terminal-tab-exit-code">
                    {`종료 (${tab.exitCode ?? '-'})`}
                  </span>
                )}
                <button
                  type="button"
                  className="terminal-tab-close"
                  aria-label={`${tab.title} 터미널 닫기`}
                  title={`${tab.title} 터미널 닫기`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                >
                  <X size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="terminal-panel-actions">
          <div className="terminal-new-split" ref={profileMenuRef}>
            <button
              type="button"
              className="icon-btn"
              aria-label="새 터미널"
              title="새 터미널 (Ctrl+Shift+`)"
              onClick={() => onNewTerminal()}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn terminal-profile-trigger"
              aria-label="셸 프로필 선택"
              title="셸 프로필 선택"
              aria-haspopup="menu"
              aria-expanded={isProfileMenuOpen}
              disabled={profiles.length === 0}
              onClick={() => setIsProfileMenuOpen((prev) => !prev)}
            >
              <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
            </button>

            {isProfileMenuOpen && profiles.length > 0 && (
              <div className="terminal-profile-menu" role="menu" aria-label="셸 프로필 목록">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    role="menuitem"
                    className="terminal-profile-menu-item"
                    onClick={() => {
                      setIsProfileMenuOpen(false)
                      onNewTerminal(profile.id)
                    }}
                  >
                    <span className="terminal-profile-menu-label">{profile.label}</span>
                    <span className="terminal-profile-menu-exec">{profile.executable}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="터미널 패널 접기"
            title="터미널 패널 접기 (Ctrl+`)"
            onClick={onCollapse}
          >
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="terminal-panel-error" role="alert">
          {errorMessage}
        </div>
      )}

      <div className="terminal-panel-body">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              data-testid={`terminal-instance-${tab.id}`}
              className={`terminal-instance${isActive ? ' is-active' : ''}`}
              onKeyDown={(event) => {
                const allowDefault = handleTerminalKeyEvent(tab.id, event.nativeEvent)
                if (!allowDefault) {
                  event.preventDefault()
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                instancesRef.current.get(tab.id)?.focus()
                pasteClipboardToSession(tab.id)
              }}
              ref={(node) => {
                if (node) {
                  containersRef.current.set(tab.id, node)
                } else {
                  containersRef.current.delete(tab.id)
                }
              }}
            />
          )
        })}
      </div>
    </section>
  )
}
