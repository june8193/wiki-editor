import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneAppConfig, DEFAULT_APP_CONFIG } from '@shared/config'
import type { WindowInitContext } from '@shared/window'
import type { FocusOpenWorkspaceResult, WorkspaceEntry } from '@shared/workspace'
import { createEmptyPersistedWorkspaceLayout } from '@shared/workspaceState'
import type { UnsavedChangesPromptRequest } from '../utils/confirmPrompts'
import {
  MainWindowWorkspaceLifecycle,
  type MainWindowWorkspaceLifecycleOptions,
  type OpenedWorkspaceTreeData
} from './MainWindowWorkspaceLifecycle'
import { PaneTabStore } from './PaneTabStore'
import type {
  RestoreWorkspaceLayoutOptions,
  RestoreWorkspaceLayoutResult,
  WorkspaceLayoutSnapshot
} from './workspaceLayoutPersistence'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface HarnessWorkspaceConfig {
  entries: Record<string, WorkspaceEntry[]>
  markdownFiles?: WorkspaceEntry[]
}

function createEntry(path: string, kind: 'file' | 'directory', rootPath: string): WorkspaceEntry {
  const norm = path.replace(/\\/g, '/')
  const normRoot = rootPath.replace(/\\/g, '/')
  const name = norm.split('/').pop() ?? norm
  const relativePath = norm.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : name
  return { name, path, relativePath, kind }
}

function createLifecycleHarness(options: {
  workspaces?: Record<string, HarnessWorkspaceConfig>
  initContext?: WindowInitContext | (() => Promise<WindowInitContext>)
  workspaceStates?: Record<string, ReturnType<typeof createEmptyPersistedWorkspaceLayout> & { expandedDirs?: string[] }>
  selectedFolder?: string | null
  debounceMs?: number
  focusIfOpen?: (rootPath: string) => Promise<FocusOpenWorkspaceResult>
  dirtySummary?: string | null
  saveDirtyResult?: boolean
  confirmUnsavedResult?: boolean
  dialogOpen?: boolean
} = {}) {
  const workspaces = options.workspaces ?? {}
  let activeRoot: string | null = null
  let currentTree: OpenedWorkspaceTreeData | null = null
  let currentExpandedDirs = new Set<string>()
  const tabStore = new PaneTabStore()
  let currentLayoutSnapshot: WorkspaceLayoutSnapshot = {
    layout: tabStore.getSnapshot(),
    buffers: {}
  }

  const savedStates = new Map<
    string,
    { expandedDirs: string[]; layout: ReturnType<typeof createEmptyPersistedWorkspaceLayout> }
  >()
  for (const [root, st] of Object.entries(options.workspaceStates ?? {})) {
    savedStates.set(root.replace(/\\/g, '/').toLowerCase(), {
      expandedDirs: st.expandedDirs ?? [],
      layout: {
        splitMode: st.splitMode,
        splitRatio: st.splitRatio,
        activePaneId: st.activePaneId,
        panes: st.panes
      }
    })
  }

  const beforeUnloadListeners = new Set<() => void>()
  const enterExplorerCalls: Array<'startup' | 'switch'> = []
  const errorCalls: Array<string | null> = []
  const removedRecents: string[] = []
  const clearedBuffersCount = { value: 0 }
  const watchCalls: string[] = []
  const unwatchCalls = { value: 0 }

  const getInitContextSpy = vi.fn(async (): Promise<WindowInitContext> => {
    if (typeof options.initContext === 'function') {
      return options.initContext()
    }
    return options.initContext ?? { role: 'main', initialTabs: [] }
  })

  const openSpy = vi.fn(async (targetPath: string) => {
    const key = Object.keys(workspaces).find(
      (k) => k.replace(/\\/g, '/').toLowerCase() === targetPath.replace(/\\/g, '/').toLowerCase()
    )
    if (!key) {
      throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${targetPath}`)
    }
    activeRoot = key
    const ws = workspaces[key]
    return {
      rootPath: key,
      name: key.replace(/\\/g, '/').split('/').pop() ?? key,
      entries: ws.entries[key] ?? []
    }
  })

  const readDirSpy = vi.fn(async (dirPath?: string) => {
    if (!activeRoot) return []
    const ws = workspaces[activeRoot]
    if (!ws) return []
    const target = dirPath ?? activeRoot
    const matchedKey = Object.keys(ws.entries).find(
      (k) => k.replace(/\\/g, '/').toLowerCase() === target.replace(/\\/g, '/').toLowerCase()
    )
    if (!matchedKey) {
      throw new Error(`ENOENT: ${target}`)
    }
    return ws.entries[matchedKey]
  })

  const workspaceStateGetSpy = vi.fn(async (rootPath: string) => {
    const found = savedStates.get(rootPath.replace(/\\/g, '/').toLowerCase())
    if (!found) return null
    return {
      rootPath,
      updatedAt: '2026-11-21T00:00:00.000Z',
      expandedDirs: [...found.expandedDirs],
      layout: found.layout
    }
  })

  const workspaceStateSaveSpy = vi.fn(async (rootPath: string, update: { expandedDirs?: readonly string[]; layout?: ReturnType<typeof createEmptyPersistedWorkspaceLayout> }) => {
    const key = rootPath.replace(/\\/g, '/').toLowerCase()
    const prev = savedStates.get(key)
    const next = {
      expandedDirs: [...(update.expandedDirs ?? prev?.expandedDirs ?? [])],
      layout: update.layout ?? prev?.layout ?? createEmptyPersistedWorkspaceLayout()
    }
    savedStates.set(key, next)
    return {
      rootPath,
      updatedAt: '2026-11-21T00:00:00.000Z',
      ...next
    }
  })

  const restoreLayoutSpy = vi.fn(
    async (_options: RestoreWorkspaceLayoutOptions): Promise<RestoreWorkspaceLayoutResult> => ({
      restored: true,
      hadPrunedTabs: false,
      reconciledLayout: createEmptyPersistedWorkspaceLayout()
    })
  )

  let dialogOpen = options.dialogOpen ?? false
  const confirmUnsavedSpy = vi.fn(
    async (_request: UnsavedChangesPromptRequest): Promise<boolean> =>
      options.confirmUnsavedResult ?? true
  )

  const deps: MainWindowWorkspaceLifecycleOptions = {
    workspaceApi: {
      selectFolder: vi.fn(async () => options.selectedFolder ?? null),
      open: openSpy,
      openInNewWindow: vi.fn(async (rootPath) => ({ status: 'opened' as const, windowId: 2, rootPath })),
      focusIfOpen: options.focusIfOpen
        ? vi.fn(options.focusIfOpen)
        : vi.fn(async (): Promise<FocusOpenWorkspaceResult> => ({ focused: false })),
      readDir: readDirSpy,
      listMarkdownFiles: vi.fn(async () => (activeRoot ? workspaces[activeRoot]?.markdownFiles ?? [] : [])),
      watch: vi.fn(async () => {
        if (activeRoot) watchCalls.push(activeRoot)
      }),
      unwatch: vi.fn(async () => {
        unwatchCalls.value += 1
      })
    },
    workspaceStateApi: {
      get: workspaceStateGetSpy,
      save: workspaceStateSaveSpy
    },
    windowApi: {
      getInitContext: getInitContextSpy
    },
    tree: {
      getExpandedDirs: () => currentExpandedDirs,
      applyOpenedWorkspace: (opened) => {
        currentTree = opened
        currentExpandedDirs = new Set(opened.expandedDirs)
      }
    },
    editor: {
      getDirtyWorkspaceSummary: () => options.dirtySummary ?? null,
      ensureAllWorkspaceBuffersSaved: vi.fn(async () => options.saveDirtyResult ?? true),
      clearWorkspaceBuffers: () => {
        clearedBuffersCount.value += 1
      },
      restoreWorkspaceLayout: restoreLayoutSpy,
      getLatestLayoutSnapshot: () => currentLayoutSnapshot
    },
    confirm: {
      confirmUnsavedChanges: confirmUnsavedSpy,
      isDialogOpen: () => dialogOpen
    },
    ui: {
      reportError: (msg) => {
        errorCalls.push(msg)
      },
      removeRecentWorkspace: (p) => {
        removedRecents.push(p)
      },
      onEnterExplorerView: (reason) => {
        enterExplorerCalls.push(reason)
      }
    },
    debounceMs: options.debounceMs ?? 250,
    beforeUnloadTarget: {
      addEventListener: (_type, listener) => {
        beforeUnloadListeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        beforeUnloadListeners.delete(listener)
      }
    }
  }

  const lifecycle = new MainWindowWorkspaceLifecycle(deps)

  return {
    lifecycle,
    deps,
    spies: {
      getInitContext: getInitContextSpy,
      open: openSpy,
      readDir: readDirSpy,
      workspaceStateGet: workspaceStateGetSpy,
      workspaceStateSave: workspaceStateSaveSpy,
      restoreLayout: restoreLayoutSpy,
      confirmUnsaved: confirmUnsavedSpy,
      selectFolder: deps.workspaceApi.selectFolder as ReturnType<typeof vi.fn>,
      openInNewWindow: deps.workspaceApi.openInNewWindow as ReturnType<typeof vi.fn>,
      focusIfOpen: deps.workspaceApi.focusIfOpen as ReturnType<typeof vi.fn>,
      ensureAllSaved: deps.editor.ensureAllWorkspaceBuffersSaved as ReturnType<typeof vi.fn>
    },
    state: {
      getCurrentTree: () => currentTree,
      setExpandedDirs: (dirs: string[]) => {
        currentExpandedDirs = new Set(dirs)
      },
      setLayoutSnapshot: (snapshot: WorkspaceLayoutSnapshot) => {
        currentLayoutSnapshot = snapshot
      },
      setDialogOpen: (next: boolean) => {
        dialogOpen = next
      },
      triggerBeforeUnload: () => {
        for (const listener of beforeUnloadListeners) {
          listener()
        }
      },
      enterExplorerCalls,
      errorCalls,
      removedRecents,
      clearedBuffersCount,
      watchCalls,
      unwatchCalls,
      savedStates
    }
  }
}

describe('MainWindowWorkspaceLifecycle startup and initContext joining', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls window.getInitContext at most once even when shared by buffer sync, and waits for initContext before falling back to recentWorkspaces[0]', async () => {
    const initDeferred = createDeferred<WindowInitContext>()
    const harness = createLifecycleHarness({
      initContext: () => initDeferred.promise,
      workspaces: {
        'C:/wiki/alpha': {
          entries: { 'C:/wiki/alpha': [createEntry('C:/wiki/alpha/a.md', 'file', 'C:/wiki/alpha')] }
        },
        'C:/wiki/beta': {
          entries: { 'C:/wiki/beta': [createEntry('C:/wiki/beta/b.md', 'file', 'C:/wiki/beta')] }
        }
      }
    })

    const stop = harness.lifecycle.start()
    const syncInitPromise = harness.lifecycle.loadInitContext()
    const duplicateInitPromise = harness.lifecycle.loadInitContext()

    expect(harness.spies.getInitContext).toHaveBeenCalledTimes(1)

    harness.lifecycle.handleInitialConfigLoaded({
      ...cloneAppConfig(DEFAULT_APP_CONFIG),
      recentWorkspaces: ['C:/wiki/alpha']
    })
    await Promise.resolve()

    expect(harness.spies.open).not.toHaveBeenCalled()

    initDeferred.resolve({
      role: 'main',
      initialTabs: [],
      initialWorkspacePath: 'C:/wiki/beta'
    })

    const [ctx1, ctx2] = await Promise.all([syncInitPromise, duplicateInitPromise])
    expect(ctx1?.initialWorkspacePath).toBe('C:/wiki/beta')
    expect(ctx2?.initialWorkspacePath).toBe('C:/wiki/beta')
    expect(harness.spies.getInitContext).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => {
      expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/beta')
    })
    expect(harness.spies.open).toHaveBeenCalledTimes(1)
    expect(harness.spies.open).toHaveBeenCalledWith('C:/wiki/beta')
    expect(harness.state.enterExplorerCalls).toEqual(['startup'])
    stop()
  })

  it('opens recentWorkspaces[0] silently on startup when initialWorkspacePath is absent and removes missing recent workspace without error banner', async () => {
    const harness = createLifecycleHarness({
      initContext: { role: 'main', initialTabs: [] },
      workspaces: {
        'C:/wiki/alpha': {
          entries: { 'C:/wiki/alpha': [createEntry('C:/wiki/alpha/a.md', 'file', 'C:/wiki/alpha')] }
        }
      }
    })

    const stop = harness.lifecycle.start()
    harness.lifecycle.handleInitialConfigLoaded({
      ...cloneAppConfig(DEFAULT_APP_CONFIG),
      recentWorkspaces: ['C:/wiki/missing']
    })

    await vi.waitFor(() => {
      expect(harness.state.removedRecents).toEqual(['C:/wiki/missing'])
    })
    expect(harness.state.errorCalls).toEqual([])
    expect(harness.state.getCurrentTree()).toBeNull()
    stop()
  })

  it('does not overwrite user-selected sidebar view when startup workspace finishes opening after user interaction', async () => {
    const openDeferred = createDeferred<{
      rootPath: string
      name: string
      entries: WorkspaceEntry[]
    }>()
    const harness = createLifecycleHarness({
      initContext: { role: 'main', initialTabs: [] },
      workspaces: {
        'C:/wiki/alpha': {
          entries: { 'C:/wiki/alpha': [] }
        }
      }
    })
    harness.spies.open.mockImplementationOnce(() => openDeferred.promise)

    const stop = harness.lifecycle.start()
    harness.lifecycle.handleInitialConfigLoaded({
      ...cloneAppConfig(DEFAULT_APP_CONFIG),
      recentWorkspaces: ['C:/wiki/alpha']
    })

    await vi.waitFor(() => {
      expect(harness.spies.open).toHaveBeenCalledWith('C:/wiki/alpha')
    })

    harness.lifecycle.markUserSelectedSidebarView()
    openDeferred.resolve({
      rootPath: 'C:/wiki/alpha',
      name: 'alpha',
      entries: []
    })

    await vi.waitFor(() => {
      expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/alpha')
    })
    expect(harness.state.enterExplorerCalls).toEqual([])
    stop()
  })
})

describe('MainWindowWorkspaceLifecycle focus check, unsaved switch guard, and race cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('transitions to Explorer without reopening or prompting when reselecting the active workspace', async () => {
    const harness = createLifecycleHarness({
      dirtySummary: 'alpha.md',
      workspaces: {
        'C:\\wiki\\alpha': {
          entries: { 'C:\\wiki\\alpha': [createEntry('C:\\wiki\\alpha\\alpha.md', 'file', 'C:\\wiki\\alpha')] }
        }
      }
    })
    const stop = harness.lifecycle.start()
    await harness.lifecycle.switchWorkspace('C:\\wiki\\alpha')
    harness.spies.open.mockClear()
    harness.spies.focusIfOpen.mockClear()
    harness.state.enterExplorerCalls.length = 0

    await harness.lifecycle.switchWorkspace('C:/wiki/alpha/')

    expect(harness.spies.focusIfOpen).not.toHaveBeenCalled()
    expect(harness.spies.confirmUnsaved).not.toHaveBeenCalled()
    expect(harness.spies.open).not.toHaveBeenCalled()
    expect(harness.state.clearedBuffersCount.value).toBe(0)
    expect(harness.state.enterExplorerCalls).toEqual(['switch'])
    stop()
  })

  it('short-circuits duplicate main window opens before unsaved confirm dialog and handles post-confirm focus races', async () => {
    let betaOpenInOtherWindow = true
    const harness = createLifecycleHarness({
      dirtySummary: 'alpha.md',
      workspaces: {
        'C:/wiki/alpha': { entries: { 'C:/wiki/alpha': [] } },
        'C:/wiki/beta': { entries: { 'C:/wiki/beta': [] } },
        'C:/wiki/gamma': { entries: { 'C:/wiki/gamma': [] } }
      },
      focusIfOpen: async (rootPath) => {
        if (rootPath.includes('beta') && betaOpenInOtherWindow) {
          return { focused: true, windowId: 2, rootPath: 'C:/wiki/beta' }
        }
        return { focused: false }
      }
    })
    const stop = harness.lifecycle.start()
    await harness.lifecycle.switchWorkspace('C:/wiki/alpha')
    harness.spies.open.mockClear()
    harness.state.errorCalls.length = 0

    // 1. Beta already open elsewhere -> focuses existing main window without prompt or workspace replacement
    await harness.lifecycle.switchWorkspace('C:/wiki/beta')
    expect(harness.spies.confirmUnsaved).not.toHaveBeenCalled()
    expect(harness.spies.open).not.toHaveBeenCalled()
    expect(harness.state.clearedBuffersCount.value).toBe(0)
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/alpha')
    expect(harness.state.errorCalls).toEqual([null])

    // 2. Gamma not open yet -> prompts unsaved changes; while dialog is open, Gamma opens in Window 2 -> post-confirm focus aborts switch
    betaOpenInOtherWindow = false
    let gammaOpenInOtherWindow = false
    harness.spies.focusIfOpen.mockImplementation(async (rootPath) => {
      if (rootPath.includes('gamma') && gammaOpenInOtherWindow) {
        return { focused: true, windowId: 2, rootPath: 'C:/wiki/gamma' }
      }
      return { focused: false }
    })
    harness.spies.confirmUnsaved.mockImplementationOnce(async (req) => {
      await req.onSave()
      gammaOpenInOtherWindow = true
      return true
    })

    await harness.lifecycle.switchWorkspace('C:/wiki/gamma')
    expect(harness.spies.confirmUnsaved).toHaveBeenCalledTimes(1)
    expect(harness.spies.ensureAllSaved).toHaveBeenCalledTimes(1)
    expect(harness.spies.open).not.toHaveBeenCalled()
    expect(harness.state.clearedBuffersCount.value).toBe(0)
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/alpha')
    stop()
  })

  it('aborts switch when unsaved confirmation is cancelled and clears buffers only after workspace.open succeeds', async () => {
    const harness = createLifecycleHarness({
      dirtySummary: 'alpha.md',
      workspaces: {
        'C:/wiki/alpha': { entries: { 'C:/wiki/alpha': [] } },
        'C:/wiki/beta': { entries: { 'C:/wiki/beta': [] } }
      }
    })
    const stop = harness.lifecycle.start()
    await harness.lifecycle.switchWorkspace('C:/wiki/alpha')

    harness.spies.confirmUnsaved.mockResolvedValueOnce(false)
    await harness.lifecycle.switchWorkspace('C:/wiki/beta')
    expect(harness.spies.open).toHaveBeenCalledTimes(1)
    expect(harness.state.clearedBuffersCount.value).toBe(0)
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/alpha')

    harness.spies.confirmUnsaved.mockResolvedValueOnce(true)
    await harness.lifecycle.switchWorkspace('C:/wiki/beta')
    expect(harness.state.clearedBuffersCount.value).toBe(1)
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/beta')
    expect(harness.state.watchCalls).toEqual(['C:/wiki/alpha', 'C:/wiki/beta'])
    stop()
  })

  it('cancels stale workspaceState lookup and stale pane layout restore on rapid switches', async () => {
    const delayedBetaState = createDeferred<null>()
    const delayedBetaLayout = createDeferred<{
      restored: boolean
      hadPrunedTabs: boolean
      reconciledLayout: ReturnType<typeof createEmptyPersistedWorkspaceLayout>
    }>()

    const harness = createLifecycleHarness({
      workspaces: {
        'C:/wiki/alpha': { entries: { 'C:/wiki/alpha': [] } },
        'C:/wiki/beta': { entries: { 'C:/wiki/beta': [] } },
        'C:/wiki/gamma': { entries: { 'C:/wiki/gamma': [] } }
      }
    })
    const stop = harness.lifecycle.start()
    await harness.lifecycle.switchWorkspace('C:/wiki/alpha')

    // Case A: delayed workspaceState.get during rapid beta -> gamma
    harness.spies.workspaceStateGet.mockImplementationOnce(async () => delayedBetaState.promise)
    const switchBetaA = harness.lifecycle.switchWorkspace('C:/wiki/beta')
    await vi.waitFor(() => {
      expect(harness.spies.workspaceStateGet).toHaveBeenCalledWith('C:/wiki/beta')
    })

    const switchGammaA = harness.lifecycle.switchWorkspace('C:/wiki/gamma')
    await switchGammaA
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/gamma')

    delayedBetaState.resolve(null)
    await switchBetaA
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/gamma')
    expect(harness.spies.restoreLayout).toHaveBeenCalledTimes(2)

    // Case B: delayed restoreWorkspaceLayout during rapid beta -> alpha
    harness.spies.restoreLayout.mockImplementationOnce(async (opts) => {
      const result = await delayedBetaLayout.promise
      return opts.isCancelled?.() ? { ...result, restored: false } : result
    })
    const switchBetaB = harness.lifecycle.switchWorkspace('C:/wiki/beta')
    await vi.waitFor(() => {
      expect(harness.spies.restoreLayout).toHaveBeenCalledTimes(3)
    })

    const switchAlphaB = harness.lifecycle.switchWorkspace('C:/wiki/alpha')
    await switchAlphaB

    delayedBetaLayout.resolve({
      restored: true,
      hadPrunedTabs: false,
      reconciledLayout: createEmptyPersistedWorkspaceLayout()
    })
    await switchBetaB
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/alpha')
    stop()
  })

  it('guards folder selection against open dialogs and surfaces openInNewWindow errors', async () => {
    const harness = createLifecycleHarness({
      selectedFolder: 'C:/wiki/alpha',
      workspaces: {
        'C:/wiki/alpha': { entries: { 'C:/wiki/alpha': [] } }
      }
    })
    const stop = harness.lifecycle.start()

    harness.state.setDialogOpen(true)
    await harness.lifecycle.selectFolder()
    expect(harness.spies.selectFolder).not.toHaveBeenCalled()

    harness.state.setDialogOpen(false)
    await harness.lifecycle.selectFolder()
    expect(harness.state.getCurrentTree()?.workspace.rootPath).toBe('C:/wiki/alpha')

    harness.spies.openInNewWindow.mockRejectedValueOnce(new Error('Window limit reached'))
    await harness.lifecycle.openInNewWindow('C:/wiki/beta')
    expect(harness.state.errorCalls.at(-1)).toBe('Window limit reached')
    stop()
  })
})

describe('MainWindowWorkspaceLifecycle encapsulated persistence, rollback, and close flush', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('encapsulates suspendAndFlush, markRestored, and resumeForWorkspace internally without exposing them on the public interface', () => {
    const harness = createLifecycleHarness()
    const publicKeys = Object.keys(harness.lifecycle)
    expect(publicKeys).not.toContain('suspendAndFlush')
    expect(publicKeys).not.toContain('markRestored')
    expect(publicKeys).not.toContain('resumeForWorkspace')
    expect('suspendAndFlush' in harness.lifecycle).toBe(false)
    expect('markRestored' in harness.lifecycle).toBe(false)
    expect('resumeForWorkspace' in harness.lifecycle).toBe(false)
  })

  it('skips redundant saves for clean restores, schedules debounced save for pruned state, and cancels debounce when reverted', async () => {
    vi.useFakeTimers()
    const harness = createLifecycleHarness({
      debounceMs: 250,
      workspaces: {
        'C:/wiki/alpha': {
          entries: {
            'C:/wiki/alpha': [createEntry('C:/wiki/alpha/docs', 'directory', 'C:/wiki/alpha')],
            'C:/wiki/alpha/docs': [createEntry('C:/wiki/alpha/docs/intro.md', 'file', 'C:/wiki/alpha')]
          }
        },
        'C:/wiki/pruned': {
          entries: {
            'C:/wiki/pruned': [createEntry('C:/wiki/pruned/docs', 'directory', 'C:/wiki/pruned')],
            'C:/wiki/pruned/docs': []
          }
        }
      },
      workspaceStates: {
        'C:/wiki/alpha': {
          ...createEmptyPersistedWorkspaceLayout(),
          expandedDirs: ['C:/wiki/alpha/docs']
        },
        'C:/wiki/pruned': {
          ...createEmptyPersistedWorkspaceLayout(),
          expandedDirs: ['C:/wiki/pruned/docs', 'C:/wiki/pruned/missing', 'C:/outside/escape']
        }
      }
    })
    const stop = harness.lifecycle.start()

    // 1. Clean restore does NOT schedule save
    await harness.lifecycle.switchWorkspace('C:/wiki/alpha')
    expect(harness.state.getCurrentTree()?.expandedDirs).toEqual(new Set(['C:/wiki/alpha/docs']))
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.spies.workspaceStateSave).not.toHaveBeenCalled()

    // 2. Collapse and re-expand back before 250ms -> cancels debounce
    harness.state.setExpandedDirs([])
    harness.lifecycle.syncPersistenceState()
    harness.state.setExpandedDirs(['C:/wiki/alpha/docs'])
    harness.lifecycle.syncPersistenceState()
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.spies.workspaceStateSave).not.toHaveBeenCalled()

    // 3. Pruned restore (outside/missing expandedDirs) schedules debounced save of pruned state
    await harness.lifecycle.switchWorkspace('C:/wiki/pruned')
    expect(harness.spies.workspaceStateSave).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(harness.spies.workspaceStateSave).toHaveBeenCalledTimes(1)
    expect(harness.state.savedStates.get('c:/wiki/pruned')?.expandedDirs).toEqual([
      'C:/wiki/pruned/docs'
    ])
    stop()
  })

  it('flushes previous workspace before switching and rolls back persistence tracking when target open fails', async () => {
    vi.useFakeTimers()
    const harness = createLifecycleHarness({
      debounceMs: 250,
      workspaces: {
        'C:/wiki/alpha': {
          entries: {
            'C:/wiki/alpha': [createEntry('C:/wiki/alpha/docs', 'directory', 'C:/wiki/alpha')],
            'C:/wiki/alpha/docs': [createEntry('C:/wiki/alpha/docs/sub', 'directory', 'C:/wiki/alpha')]
          }
        },
        'C:/wiki/beta': {
          entries: { 'C:/wiki/beta': [] }
        }
      }
    })
    const stop = harness.lifecycle.start()
    await harness.lifecycle.switchWorkspace('C:/wiki/alpha')

    // Expand docs, then immediately attempt switch to failing workspace -> flushes docs before open, rolls back on failure
    harness.state.setExpandedDirs(['C:/wiki/alpha/docs'])
    harness.lifecycle.syncPersistenceState()
    await harness.lifecycle.switchWorkspace('C:/wiki/broken')

    expect(harness.state.errorCalls.at(-1)).toContain('워크스페이스 폴더를 찾을 수 없습니다')
    expect(harness.state.savedStates.get('c:/wiki/alpha')?.expandedDirs).toEqual([
      'C:/wiki/alpha/docs'
    ])

    // Subsequent expansion in alpha MUST still be tracked & debounced/flushed after failure rollback
    harness.state.setExpandedDirs(['C:/wiki/alpha/docs', 'C:/wiki/alpha/docs/sub'])
    harness.lifecycle.syncPersistenceState()
    await vi.advanceTimersByTimeAsync(250)
    expect(harness.state.savedStates.get('c:/wiki/alpha')?.expandedDirs).toEqual([
      'C:/wiki/alpha/docs',
      'C:/wiki/alpha/docs/sub'
    ])
    stop()
  })

  it('flushes pending workspace state immediately before close, on beforeunload, and on dispose without duplicate saves, and calls unwatch on dispose', async () => {
    const harness = createLifecycleHarness({
      workspaces: {
        'C:/wiki/alpha': {
          entries: {
            'C:/wiki/alpha': [createEntry('C:/wiki/alpha/docs', 'directory', 'C:/wiki/alpha')],
            'C:/wiki/alpha/docs': []
          }
        }
      }
    })
    const stop = harness.lifecycle.start()
    await harness.lifecycle.switchWorkspace('C:/wiki/alpha')

    // 1. Pre-close flush saves immediately without waiting for 250ms timer; subsequent duplicate flush is a no-op
    harness.state.setExpandedDirs(['C:/wiki/alpha/docs'])
    await harness.lifecycle.flushWorkspaceState()
    expect(harness.spies.workspaceStateSave).toHaveBeenCalledTimes(1)
    expect(harness.state.savedStates.get('c:/wiki/alpha')?.expandedDirs).toEqual([
      'C:/wiki/alpha/docs'
    ])

    await harness.lifecycle.flushWorkspaceState()
    expect(harness.spies.workspaceStateSave).toHaveBeenCalledTimes(1)

    // 2. beforeunload flushes new changes immediately
    harness.state.setExpandedDirs([])
    harness.state.triggerBeforeUnload()
    await Promise.resolve()
    expect(harness.spies.workspaceStateSave).toHaveBeenCalledTimes(2)
    expect(harness.state.savedStates.get('c:/wiki/alpha')?.expandedDirs).toEqual([])

    // 3. dispose flushes any remaining dirty state and stops workspace watch
    harness.state.setExpandedDirs(['C:/wiki/alpha/docs'])
    stop()
    await Promise.resolve()
    expect(harness.spies.workspaceStateSave).toHaveBeenCalledTimes(3)
    expect(harness.state.unwatchCalls.value).toBe(1)
  })
})


