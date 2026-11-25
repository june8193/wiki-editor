import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type { WikiApi } from '@shared/ipc'
import { TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS } from '@shared/terminal'
import type { TerminalTabState } from '../components/TerminalPanel'
import {
  clampTerminalHeight,
  getTerminalHeightBounds,
  TERMINAL_DEFAULT_HEIGHT
} from '../utils/terminalHeight'

export interface UseTerminalSessionOptions {
  wikiApi: WikiApi
  workspaceRootPath: string | null
  windowHeight: number
}

/**
 * Manages integrated terminal panel visibility, height, multi-tab PTY sessions,
 * data/exit event routing, and clean session teardown on workspace switch.
 */
export function useTerminalSession({
  wikiApi,
  workspaceRootPath,
  windowHeight
}: UseTerminalSessionOptions) {
  const heightBounds = useMemo(() => getTerminalHeightBounds(windowHeight), [windowHeight])
  const [isOpen, setIsOpen] = useState(false)
  const [tabs, setTabs] = useState<TerminalTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [rawHeight, setRawHeight] = useState(TERMINAL_DEFAULT_HEIGHT)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const height = clampTerminalHeight(rawHeight, heightBounds)

  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const workspaceRootRef = useRef(workspaceRootPath)
  workspaceRootRef.current = workspaceRootPath
  const prevWorkspaceRootRef = useRef<string | null>(workspaceRootPath)
  const dataListenersRef = useRef<Set<(sessionId: string, data: string) => void>>(new Set())

  useEffect(() => {
    const terminalApi = wikiApi.terminal
    if (!terminalApi) return

    const unsubData = terminalApi.onData((event) => {
      for (const listener of dataListenersRef.current) {
        listener(event.sessionId, event.data)
      }
    })
    const unsubExit = terminalApi.onExit((event) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === event.sessionId
            ? { ...tab, isRunning: false, exitCode: event.exitCode }
            : tab
        )
      )
    })

    return () => {
      unsubData()
      unsubExit()
    }
  }, [wikiApi])

  // Clear all terminal tabs and close PTY sessions when switching workspaces.
  useEffect(() => {
    if (prevWorkspaceRootRef.current === workspaceRootPath) {
      return
    }
    prevWorkspaceRootRef.current = workspaceRootPath

    const previousTabs = tabsRef.current
    for (const tab of previousTabs) {
      void wikiApi.terminal?.closeSession(tab.id).catch(() => undefined)
    }
    setTabs([])
    setActiveTabId(null)
    setIsOpen(false)
    setErrorMessage(null)
  }, [workspaceRootPath, wikiApi])

  const createNewTerminal = useCallback(
    async (profileId?: string): Promise<void> => {
      setIsOpen(true)
      setErrorMessage(null)

      const terminalApi = wikiApi.terminal
      if (!terminalApi) {
        setErrorMessage('터미널 API를 사용할 수 없습니다.')
        return
      }

      const startedRoot = workspaceRootRef.current
      try {
        const session = await terminalApi.createSession({
          profileId,
          cols: TERMINAL_DEFAULT_COLS,
          rows: TERMINAL_DEFAULT_ROWS
        })
        if (startedRoot !== workspaceRootRef.current) {
          void terminalApi.closeSession(session.id).catch(() => undefined)
          return
        }
        const nextTab: TerminalTabState = {
          id: session.id,
          profileId: session.profileId,
          title: session.title,
          isRunning: session.isRunning,
          exitCode: null
        }
        setTabs((prev) => [...prev, nextTab])
        setActiveTabId(session.id)
      } catch (error: unknown) {
        if (startedRoot !== workspaceRootRef.current) {
          return
        }
        setErrorMessage(toErrorMessage(error, '터미널 세션을 시작하지 못했습니다.'))
      }
    },
    [wikiApi]
  )

  const toggleTerminal = useCallback((): void => {
    if (isOpenRef.current) {
      setIsOpen(false)
      return
    }
    setIsOpen(true)
    if (tabsRef.current.length === 0) {
      void createNewTerminal()
    }
  }, [createNewTerminal])

  const selectTab = useCallback((tabId: string): void => {
    setActiveTabId(tabId)
  }, [])

  const closeTab = useCallback(
    (tabId: string): void => {
      void wikiApi.terminal?.closeSession(tabId).catch(() => undefined)
      setTabs((prev) => {
        const index = prev.findIndex((tab) => tab.id === tabId)
        if (index < 0) return prev
        const nextTabs = prev.filter((tab) => tab.id !== tabId)
        setActiveTabId((currentActive) => {
          if (currentActive !== tabId) return currentActive
          if (nextTabs.length === 0) return null
          const fallback = nextTabs[Math.min(index, nextTabs.length - 1)]
          return fallback.id
        })
        if (nextTabs.length === 0) {
          setIsOpen(false)
        }
        return nextTabs
      })
    },
    [wikiApi]
  )

  const collapsePanel = useCallback((): void => {
    setIsOpen(false)
  }, [])

  const resizePanel = useCallback(
    (nextHeight: number): void => {
      setRawHeight(clampTerminalHeight(nextHeight, heightBounds))
    },
    [heightBounds]
  )

  const writeSession = useCallback(
    (sessionId: string, data: string): void => {
      void wikiApi.terminal?.write(sessionId, data).catch(() => undefined)
    },
    [wikiApi]
  )

  const resizeSession = useCallback(
    (sessionId: string, cols: number, rows: number): void => {
      void wikiApi.terminal?.resize(sessionId, cols, rows).catch(() => undefined)
    },
    [wikiApi]
  )

  const subscribeSessionData = useCallback(
    (listener: (sessionId: string, data: string) => void): (() => void) => {
      dataListenersRef.current.add(listener)
      return () => {
        dataListenersRef.current.delete(listener)
      }
    },
    []
  )

  return {
    isOpen,
    tabs,
    activeTabId,
    height,
    heightBounds,
    errorMessage,
    actions: {
      toggleTerminal,
      createNewTerminal,
      selectTab,
      closeTab,
      collapsePanel,
      resizePanel,
      writeSession,
      resizeSession,
      subscribeSessionData
    }
  }
}
