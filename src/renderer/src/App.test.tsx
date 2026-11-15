import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AppConfig,
  cloneAppConfig,
  DEFAULT_APP_CONFIG,
  validateConfigRaw
} from '@shared/config'
import {
  createEmptyGitStatus,
  type GitDiffRequest,
  type GitFileStatusCode,
  type GitGraphCommit,
  type GitLogResult
} from '@shared/git'
import type { AppMenuCommand, WikiApi, WikiGitApi, WikiLogApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import {
  addFavoriteWorkspace,
  getWorkspaceDisplayName,
  recordRecentWorkspace,
  removeFavoriteWorkspace,
  toggleFavoriteWorkspace,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind
} from '@shared/workspace'
import { defaultMermaidRenderer } from './editor/mermaidRenderer'
import { App } from './App'
import themeCss from './styles/theme.css?raw'

const mermaidMockState = vi.hoisted(() => {
  let activeTheme = 'default'
  const initialize = vi.fn((cfg?: { theme?: string }) => {
    activeTheme = cfg?.theme ?? 'default'
  })
  const render = vi.fn(async (_id: string, text: string) => {
    if (text.includes('SYNTAX_ERROR')) {
      throw new Error('Syntax error in Mermaid graph')
    }
    return {
      svg: `<svg data-mermaid-theme="${activeTheme}" data-code="${text.trim()}"><g><text>DiagramOK</text></g></svg>`
    }
  })
  return {
    initialize,
    render,
    reset: () => {
      activeTheme = 'default'
      initialize.mockClear()
      render.mockClear()
    }
  }
})

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidMockState.initialize,
    render: mermaidMockState.render
  }
}))

function mockPrototypeScrollIntoView(): {
  mock: ReturnType<typeof vi.fn>
  restore: () => void
} {
  const mock = vi.fn()
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: mock
  })
  return {
    mock,
    restore: () => {
      if (origDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origDescriptor)
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
    }
  }
}

interface VirtualFsOptions {
  workspaces?: Record<string, Record<string, string | null>>
  selectedFolder?: string | null
  git?: Partial<WikiGitApi>
  log?: WikiLogApi
}

function normalizePosix(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function getRawEditorView(editorEl: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(editorEl)
  if (!view) {
    throw new Error('Could not resolve CodeMirror EditorView for element')
  }
  return view
}

function getRawEditorText(editorEl: HTMLElement): string {
  return getRawEditorView(editorEl).state.doc.toString()
}

function setRawEditorText(editorEl: HTMLElement, nextText: string): void {
  const view = getRawEditorView(editorEl)
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextText }
    })
  })
}

function appendRawEditorText(editorEl: HTMLElement, suffix: string): void {
  const view = getRawEditorView(editorEl)
  const end = view.state.doc.length
  act(() => {
    view.dispatch({
      changes: { from: end, to: end, insert: suffix },
      selection: { anchor: end + suffix.length }
    })
  })
}

function setRawEditorSelection(editorEl: HTMLElement, start: number, end: number): void {
  const view = getRawEditorView(editorEl)
  act(() => {
    view.dispatch({
      selection: { anchor: start, head: end }
    })
  })
}

function getRawEditorSelection(editorEl: HTMLElement): { start: number; end: number } {
  return {
    start: Number(editorEl.getAttribute('data-selection-start') ?? 0),
    end: Number(editorEl.getAttribute('data-selection-end') ?? 0)
  }
}

function getRawEditorScroller(editorEl: HTMLElement): HTMLElement {
  return getRawEditorView(editorEl).scrollDOM
}

function parentDirOf(pathValue: string): string {
  const norm = normalizePosix(pathValue)
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '/' : norm.slice(0, idx)
}

function baseNameOf(pathValue: string): string {
  const norm = normalizePosix(pathValue)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? norm : norm.slice(idx + 1)
}

function createInMemoryWikiApi(
  initialOverrides: Partial<AppConfig> = {},
  fsOptions: VirtualFsOptions = {}
): {
  api: WikiApi
  emitExternalChange: (patch: Partial<AppConfig>) => void
  emitWorkspaceChange: (event: WorkspaceChangeEvent) => void
  emitMenuCommand: (command: AppMenuCommand) => void
  getListenerCount: () => number
  getMenuListenerCount: () => number
  getFilesSnapshot: () => Map<string, string>
  readDirCalls: string[]
} {
  let state: AppConfig = {
    ...cloneAppConfig(DEFAULT_APP_CONFIG),
    ...initialOverrides
  }
  const configListeners = new Set<(config: AppConfig) => void>()
  const workspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
  const menuListeners = new Set<(command: AppMenuCommand) => void>()
  const configPath = 'C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json'

  // Virtual directory & file map keyed by normalized POSIX-style paths
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const readDirCalls: string[] = []
  let activeRoot: string | null = null
  let selectedFolder: string | null = fsOptions.selectedFolder ?? null

  for (const [rootRaw, entries] of Object.entries(fsOptions.workspaces ?? {})) {
    const root = normalizePosix(rootRaw)
    dirs.add(root)
    for (const [relRaw, content] of Object.entries(entries)) {
      const rel = relRaw.replace(/\\/g, '/').replace(/^\/+/, '')
      const parts = rel.split('/').filter(Boolean)
      let cursor = root
      for (let i = 0; i < parts.length; i += 1) {
        cursor = `${cursor}/${parts[i]}`
        const isLast = i === parts.length - 1
        if (isLast && content !== null) {
          files.set(cursor, content)
        } else {
          dirs.add(cursor)
        }
      }
    }
  }

  const listDir = (dirPath: string): WorkspaceEntry[] => {
    const target = normalizePosix(dirPath === '.' && activeRoot ? activeRoot : dirPath)
    readDirCalls.push(target)
    if (!dirs.has(target)) {
      throw new Error(`폴더를 찾을 수 없습니다: ${dirPath}`)
    }
    const entries: WorkspaceEntry[] = []
    for (const dir of dirs) {
      if (dir !== target && parentDirOf(dir) === target) {
        const name = baseNameOf(dir)
        entries.push({
          name,
          path: dir,
          relativePath: activeRoot ? dir.slice(activeRoot.length + 1) : name,
          kind: 'directory'
        })
      }
    }
    for (const file of files.keys()) {
      if (parentDirOf(file) === target) {
        const name = baseNameOf(file)
        entries.push({
          name,
          path: file,
          relativePath: activeRoot ? file.slice(activeRoot.length + 1) : name,
          kind: 'file'
        })
      }
    }
    return entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  const applyAndBroadcast = (nextState: AppConfig): AppConfig => {
    state = cloneAppConfig(nextState)
    const snapshot = cloneAppConfig(state)
    for (const listener of configListeners) {
      listener(snapshot)
    }
    return cloneAppConfig(snapshot)
  }

  const api: WikiApi = {
    config: {
      async get() {
        return cloneAppConfig(state)
      },
      async update(patch) {
        return applyAndBroadcast({ ...state, ...patch, version: 1 })
      },
      async getConfigPath() {
        return configPath
      },
      async readRaw() {
        return JSON.stringify(state, null, 2)
      },
      async saveRaw(raw) {
        const validated = validateConfigRaw(raw)
        return applyAndBroadcast(validated)
      },
      async toggleFavoriteWorkspace(workspacePath, name) {
        return applyAndBroadcast({
          ...state,
          favoriteWorkspaces: toggleFavoriteWorkspace(
            state.favoriteWorkspaces,
            workspacePath,
            name
          )
        })
      },
      async removeFavoriteWorkspace(workspacePath) {
        return applyAndBroadcast({
          ...state,
          favoriteWorkspaces: removeFavoriteWorkspace(state.favoriteWorkspaces, workspacePath)
        })
      },
      onChanged(listener) {
        configListeners.add(listener)
        return () => {
          configListeners.delete(listener)
        }
      }
    },
    workspace: {
      async selectFolder() {
        return selectedFolder
      },
      async open(rootPath) {
        const normalized = normalizePosix(rootPath)
        if (!dirs.has(normalized)) {
          throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${rootPath}`)
        }
        activeRoot = normalized
        applyAndBroadcast({
          ...state,
          recentWorkspaces: recordRecentWorkspace(state.recentWorkspaces, rootPath)
        })
        return {
          rootPath: normalized,
          name: getWorkspaceDisplayName(normalized),
          entries: listDir(normalized)
        }
      },
      async readDir(dirPath) {
        if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
        return listDir(dirPath ?? activeRoot)
      },
      async readFile(filePath) {
        const normalized = normalizePosix(filePath)
        const content = files.get(normalized)
        if (content === undefined) {
          throw new Error(`파일을 찾을 수 없습니다: ${filePath}`)
        }
        return content
      },
      async writeFile(filePath, content) {
        const normalized = normalizePosix(filePath)
        if (!files.has(normalized) && !dirs.has(parentDirOf(normalized))) {
          throw new Error(`경로를 찾을 수 없습니다: ${filePath}`)
        }
        files.set(normalized, content)
      },
      async createEntry(parentDirPath, name, kind: WorkspaceEntryKind, initialContent = '') {
        if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
        const parent = normalizePosix(parentDirPath === '.' ? activeRoot : parentDirPath)
        const target = `${parent}/${name}`
        if (dirs.has(target) || files.has(target)) {
          throw new Error(`이미 존재하는 파일 또는 폴더입니다: ${name}`)
        }
        if (kind === 'directory') {
          dirs.add(target)
        } else {
          files.set(target, initialContent)
        }
        return {
          name,
          path: target,
          relativePath: target.slice(activeRoot.length + 1),
          kind
        }
      },
      async renameEntry(targetPath, newName) {
        if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
        const target = normalizePosix(targetPath)
        const next = `${parentDirOf(target)}/${newName}`
        if (dirs.has(next) || files.has(next)) {
          throw new Error(`이미 존재하는 이름입니다: ${newName}`)
        }
        if (files.has(target)) {
          const content = files.get(target)!
          files.delete(target)
          files.set(next, content)
          return {
            name: newName,
            path: next,
            relativePath: next.slice(activeRoot.length + 1),
            kind: 'file'
          }
        }
        if (dirs.has(target)) {
          const movedDirs = [...dirs].filter((d) => d === target || d.startsWith(`${target}/`))
          const movedFiles = [...files.entries()].filter(([f]) => f.startsWith(`${target}/`))
          for (const d of movedDirs) {
            dirs.delete(d)
            dirs.add(next + d.slice(target.length))
          }
          for (const [f, c] of movedFiles) {
            files.delete(f)
            files.set(next + f.slice(target.length), c)
          }
          return {
            name: newName,
            path: next,
            relativePath: next.slice(activeRoot.length + 1),
            kind: 'directory'
          }
        }
        throw new Error(`경로를 찾을 수 없습니다: ${targetPath}`)
      },
      async deleteEntry(targetPath) {
        const target = normalizePosix(targetPath)
        if (files.has(target)) {
          files.delete(target)
          return
        }
        if (dirs.has(target)) {
          for (const d of [...dirs]) {
            if (d === target || d.startsWith(`${target}/`)) dirs.delete(d)
          }
          for (const f of [...files.keys()]) {
            if (f.startsWith(`${target}/`)) files.delete(f)
          }
          return
        }
        throw new Error(`경로를 찾을 수 없습니다: ${targetPath}`)
      },
      async watch() {},
      async unwatch() {},
      onChanged(listener) {
        workspaceListeners.add(listener)
        return () => {
          workspaceListeners.delete(listener)
        }
      }
    },
    git: {
      status: async (workspacePath) => createEmptyGitStatus(false, workspacePath),
      init: async (workspacePath) => ({
        ...createEmptyGitStatus(true, workspacePath),
        branch: 'main',
        isUnborn: true
      }),
      stage: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      stageAll: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      unstage: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      unstageAll: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      commit: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      branches: async () => ({ current: null, isDetached: false, branches: [] }),
      checkout: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      pull: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      push: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
      sync: async (workspacePath) => ({
        status: createEmptyGitStatus(true, workspacePath),
        pulled: true,
        pushed: true,
        summary: '동기화 완료'
      }),
      log: async () => ({ commits: [], hasMore: false }),
      commitDetail: async (_workspacePath, commitHash) => ({
        hash: commitHash,
        shortHash: commitHash.slice(0, 7),
        parents: [],
        subject: '',
        body: '',
        authorName: '',
        authorEmail: '',
        committedAt: '',
        files: []
      }),
      diff: async (_workspacePath, request) => ({
        path: request.path,
        ...(request.origPath ? { origPath: request.origPath } : {}),
        status: request.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: ''
      }),
      ...fsOptions.git
    },
    menu: {
      onCommand(listener) {
        menuListeners.add(listener)
        return () => {
          menuListeners.delete(listener)
        }
      }
    },
    ...(fsOptions.log ? { log: fsOptions.log } : {})
  }

  return {
    api,
    emitExternalChange(patch) {
      applyAndBroadcast({ ...state, ...patch, version: 1 })
    },
    emitWorkspaceChange(event) {
      for (const listener of workspaceListeners) {
        listener(event)
      }
    },
    emitMenuCommand(command) {
      for (const listener of menuListeners) {
        listener(command)
      }
    },
    getListenerCount: () => configListeners.size,
    getMenuListenerCount: () => menuListeners.size,
    getFilesSnapshot: () => new Map(files),
    readDirCalls
  }
}

async function triggerMenuCommand(
  emitMenuCommand: (command: AppMenuCommand) => void,
  command: AppMenuCommand
): Promise<void> {
  await act(async () => {
    emitMenuCommand(command)
  })
}

async function clickActivityBarButton(
  user: ReturnType<typeof userEvent.setup>,
  label: '탐색기' | 'Git' | '워크스페이스'
): Promise<void> {
  const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
  await user.click(within(activityBar).getByRole('button', { name: label }))
}

describe('App shell, theme persistence, and settings panel', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('removes the internal app-header completely and updates empty-state guidance in workspace and explorer views', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi()
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(document.querySelector('header.app-header')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Wiki Editor' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /테마 전환/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^설정$/i })).not.toBeInTheDocument()

    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(workspaceView).getByText('열린 워크스페이스 없음')).toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: '폴더 열기...' })).toBeInTheDocument()
    expect(within(workspaceView).getByText('등록된 즐겨찾기가 없습니다.')).toBeInTheDocument()
    expect(within(workspaceView).getByText('최근 연 폴더가 없습니다.')).toBeInTheDocument()

    await clickActivityBarButton(user, '탐색기')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(within(sidebar).queryByRole('button', { name: /폴더 열기/i })).not.toBeInTheDocument()
    expect(within(sidebar).queryByRole('button', { name: /워크스페이스 전환/i })).not.toBeInTheDocument()
    expect(within(sidebar).getByText('열린 워크스페이스 없음')).toBeInTheDocument()
    expect(
      within(sidebar).getByText("File 메뉴의 '폴더 열기' 또는 워크스페이스 뷰에서 폴더를 열어 시작하세요.")
    ).toBeInTheDocument()
  })

  it('initializes document theme from persisted config on mount', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'dark' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })

  it('toggles theme via application menu command, updates data-theme immediately, and persists across restart', async () => {
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    const firstMount = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })

    firstMount.unmount()
    document.documentElement.removeAttribute('data-theme')

    render(<App />)
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })

  it('displays config.json path and opens config.json in the editor when clicking 설정 파일 직접 열기', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light', autoSave: true })
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')

    expect(
      await screen.findByText('C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json')
    ).toBeInTheDocument()

    const settingsThemeToggle = screen.getByRole('button', { name: /다크 모드로 전환/i })
    await user.click(settingsThemeToggle)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })

    const openConfigButton = screen.getByRole('button', { name: /설정 파일 직접 열기/i })
    await user.click(openConfigButton)

    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
    const editor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editor)).toContain('"theme": "dark"')
    expect(getRawEditorText(editor)).toContain('"autoSave": true')
  })

  it('reacts to external config change broadcasts and cleans up listener on unmount', async () => {
    const { api, emitExternalChange, getListenerCount } = createInMemoryWikiApi({
      theme: 'light'
    })
    window.wikiApi = api

    const view = render(<App />)

    await waitFor(() => {
      expect(getListenerCount()).toBe(1)
    })

    emitExternalChange({ theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })

    view.unmount()
    expect(getListenerCount()).toBe(0)
  })

  it('refreshes open clean config.json editor when an external change arrives', async () => {
    const user = userEvent.setup()
    const { api, emitExternalChange, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const editor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editor)).toContain('"theme": "light"')

    emitExternalChange({ theme: 'dark' })

    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('"theme": "dark"')
    })
  })

  it('rolls back theme and shows an error banner when saving theme fails', async () => {
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    api.config.update = async () => {
      throw new Error('디스크 쓰기 오류')
    }
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')

    expect(await screen.findByRole('alert')).toHaveTextContent('디스크 쓰기 오류')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('keeps the latest theme when rapid toggles resolve out of order', async () => {
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })

    let resolveFirst!: (value: AppConfig) => void
    let callCount = 0
    api.config.update = (patch) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<AppConfig>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({ ...cloneAppConfig(DEFAULT_APP_CONFIG), ...patch })
    }
    window.wikiApi = api

    render(<App />)
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')

    resolveFirst({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })
  })

  it('shows an error banner when reading raw config fails', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    api.config.readRaw = async () => {
      throw new Error('읽기 권한 없음')
    }
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('읽기 권한 없음')
  })

  it('closes the settings panel when clicking 닫기 and surfaces initial load failures', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    const view = render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toHaveAttribute('aria-modal', 'true')

    await user.click(screen.getByRole('button', { name: /닫기/i }))
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    view.unmount()

    const failingHarness = createInMemoryWikiApi()
    failingHarness.api.config.get = async () => {
      throw new Error('초기 설정 로드 실패')
    }
    window.wikiApi = failingHarness.api

    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('초기 설정 로드 실패')
    await triggerMenuCommand(failingHarness.emitMenuCommand, 'toggle-settings')
    expect(
      await screen.findByText('C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json')
    ).toBeInTheDocument()
  })

  it('keeps error banner visible and avoids stale raw read when saving theme fails while config editor is open', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    let readRawCalls = 0
    const origReadRaw = api.config.readRaw
    api.config.readRaw = async () => {
      readRawCalls += 1
      return origReadRaw()
    }
    api.config.update = async () => {
      throw new Error('저장 실패 유지 테스트')
    }
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))
    await screen.findByTestId('document-editor')
    const callsBeforeToggle = readRawCalls

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')

    expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패 유지 테스트')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(readRawCalls).toBe(callsBeforeToggle)
  })

  it('surfaces error and avoids flicker when onChanged from first toggle arrives during second failing toggle', async () => {
    const { api, emitExternalChange, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })

    let resolveFirst!: (value: AppConfig) => void
    let rejectSecond!: (error: Error) => void
    let callCount = 0
    api.config.update = () => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<AppConfig>((resolve) => {
          resolveFirst = resolve
        })
      }
      return new Promise<AppConfig>((_resolve, reject) => {
        rejectSecond = reject
      })
    }
    window.wikiApi = api

    render(<App />)
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')

    emitExternalChange({ theme: 'dark' })
    resolveFirst({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    rejectSecond(new Error('두 번째 저장 실패'))

    expect(await screen.findByRole('alert')).toHaveTextContent('두 번째 저장 실패')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('applies persisted config if an early toggle fails before initial get() resolves', async () => {
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'dark' })

    let resolveGet!: (value: AppConfig) => void
    api.config.get = () =>
      new Promise<AppConfig>((resolve) => {
        resolveGet = resolve
      })
    api.config.update = async () => {
      throw new Error('초기 로드 전 저장 실패')
    }
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    expect(await screen.findByRole('alert')).toHaveTextContent('초기 로드 전 저장 실패')

    resolveGet({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })

  it('handles toggle-theme and toggle-settings application menu commands and cleans up listener on unmount', async () => {
    const { api, emitMenuCommand, getMenuListenerCount } = createInMemoryWikiApi({
      theme: 'light'
    })
    window.wikiApi = api

    const view = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
      expect(getMenuListenerCount()).toBe(1)
    })

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
    expect((await api.config.get()).theme).toBe('dark')

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    view.unmount()
    expect(getMenuListenerCount()).toBe(0)
  })

  it('handles open-folder application menu command with unsaved changes confirmation dialog (저장 후 이동 / 버리고 이동)', async () => {
    const user = userEvent.setup()
    let nextSelectedFolder = 'C:\\wiki\\first'
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        workspaces: {
          'C:\\wiki\\first': { 'first.md': '# First' },
          'C:\\wiki\\second': { 'second.md': '# Second' },
          'C:\\wiki\\third': { 'third.md': '# Third' }
        }
      }
    )
    api.workspace.selectFolder = async () => nextSelectedFolder
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('first.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), ' edited')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Trigger File > 폴더 열기... with unsaved changes -> cancel preserves current workspace
    nextSelectedFolder = 'C:\\wiki\\second'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const cancelDialog = await screen.findByRole('alertdialog')
    expect(within(cancelDialog).getByRole('button', { name: '저장 후 이동' })).toBeInTheDocument()
    expect(within(cancelDialog).getByRole('button', { name: '버리고 이동' })).toBeInTheDocument()
    await user.click(within(cancelDialog).getByRole('button', { name: '취소' }))
    expect(within(sidebar).getByText('first.md')).toBeInTheDocument()

    // Retry File > 폴더 열기... and choose 저장 후 이동 -> saves edit and switches workspace
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const saveDialog = await screen.findByRole('alertdialog')
    await user.click(within(saveDialog).getByRole('button', { name: '저장 후 이동' }))
    expect(await within(sidebar).findByText('second.md')).toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/first/first.md')).toBe('# First edited')

    // Make dirty edit in second workspace and choose 버리고 이동 on open-folder
    await user.click(within(sidebar).getByText('second.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), ' discarded')
    nextSelectedFolder = 'C:\\wiki\\third'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const discardDialog = await screen.findByRole('alertdialog')
    await user.click(within(discardDialog).getByRole('button', { name: '버리고 이동' }))
    expect(await within(sidebar).findByText('third.md')).toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/second/second.md')).toBe('# Second')
  })

  it('ignores application menu commands while a ConfirmDialog is open without breaking pending Git mutations', async () => {
    const user = userEvent.setup()
    const gitStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki/first'),
      branch: 'main',
      hasUpstream: true
    }
    const pullMock = vi.fn(async () => gitStatus)
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\first',
        workspaces: {
          'C:\\wiki\\first': { 'dirty.md': '# Dirty' },
          'C:\\wiki\\second': { 'second.md': '# Second' }
        },
        git: {
          status: vi.fn(async () => gitStatus),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [{ name: 'main', current: true, upstream: 'origin/main' }]
          })),
          pull: pullMock
        }
      }
    )
    const selectFolderSpy = vi.fn(async () => 'C:\\wiki\\second')
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    api.workspace.selectFolder = selectFolderSpy

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('dirty.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), ' unsaved')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: 'Pull' }))
    const gitDialog = await screen.findByRole('alertdialog')

    // Native menu commands triggered while modal ConfirmDialog is active should be ignored
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')

    expect(selectFolderSpy).not.toHaveBeenCalled()
    expect(configUpdateSpy).not.toHaveBeenCalled()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(screen.queryByLabelText('전역 설정 패널')).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBe(gitDialog)

    // Original Git ConfirmDialog still resolves cleanly without deadlocking Git mutations
    await user.click(within(gitDialog).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(pullMock).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
  })

  it('prevents overlapping selectFolder calls when open-folder fires while a folder picker is pending', async () => {
    let resolveFirstSelect!: (value: string | null) => void
    let callCount = 0
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        workspaces: {
          'C:\\wiki\\first': { 'first.md': '# First' },
          'C:\\wiki\\second': { 'second.md': '# Second' }
        }
      }
    )
    const selectFolderSpy = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) {
        return await new Promise<string | null>((resolve) => {
          resolveFirstSelect = resolve
        })
      }
      return 'C:\\wiki\\second'
    })
    api.workspace.selectFolder = selectFolderSpy
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(selectFolderSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstSelect('C:\\wiki\\first')
    })
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('first.md')).toBeInTheDocument()

    // Once the first folder picker resolves, subsequent open-folder calls work normally
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(selectFolderSpy).toHaveBeenCalledTimes(2)
    expect(await within(sidebar).findByText('second.md')).toBeInTheDocument()
  })
})

describe('Workspace folder tree, favorites, editing, and saving', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('opens a workspace folder via dialog, lazily loads 1-depth subfolders on click, and collapses cleanly', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, readDirCalls } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\project',
        workspaces: {
          'C:\\wiki\\project': {
            'docs/intro.md': '# Intro',
            'readme.md': '# Root Readme'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('docs')).toBeInTheDocument()
    expect(within(sidebar).getByText('readme.md')).toBeInTheDocument()
    // Subfolder children must NOT be loaded until clicked
    expect(within(sidebar).queryByText('intro.md')).not.toBeInTheDocument()
    expect(readDirCalls).toEqual(['C:/wiki/project'])

    // Expanding folder triggers 1-depth lazy load
    await user.click(within(sidebar).getByText('docs'))
    expect(await within(sidebar).findByText('intro.md')).toBeInTheDocument()
    expect(readDirCalls).toEqual(['C:/wiki/project', 'C:/wiki/project/docs'])

    // Collapsing hides child without re-fetching
    await user.click(within(sidebar).getByText('docs'))
    expect(within(sidebar).queryByText('intro.md')).not.toBeInTheDocument()
  })

  it('creates files/folders, renames via F2 and context menu, and deletes after confirmation', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\notes',
        workspaces: {
          'C:\\wiki\\notes': {
            'existing.md': '# Existing'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await within(sidebar).findByText('existing.md')

    // Create folder
    await user.click(within(sidebar).getByRole('button', { name: /새 폴더/i }))
    const folderInput = await within(sidebar).findByLabelText('새 폴더 이름')
    await user.type(folderInput, 'guides{Enter}')
    expect(await within(sidebar).findByText('guides')).toBeInTheDocument()

    // Create file via context menu on folder
    fireEvent.contextMenu(within(sidebar).getByText('guides'))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /새 파일/i }))
    const fileInput = await within(sidebar).findByLabelText('새 파일 이름')
    await user.type(fileInput, 'setup.md{Enter}')

    expect(await within(sidebar).findByText('setup.md')).toBeInTheDocument()
    expect(getFilesSnapshot().has('C:/wiki/notes/guides/setup.md')).toBe(true)

    // Rename file via F2 shortcut
    const setupItem = within(sidebar).getByRole('treeitem', { name: 'setup.md' })
    setupItem.focus()
    fireEvent.keyDown(setupItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'getting-started.md{Enter}')

    expect(await within(sidebar).findByText('getting-started.md')).toBeInTheDocument()
    expect(getFilesSnapshot().has('C:/wiki/notes/guides/getting-started.md')).toBe(true)

    // Delete via context menu + confirmation dialog
    fireEvent.contextMenu(within(sidebar).getByText('getting-started.md'))
    const deleteMenu = await screen.findByRole('menu')
    await user.click(within(deleteMenu).getByRole('menuitem', { name: /삭제/i }))

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /삭제 확인/i }))

    await waitFor(() => {
      expect(within(sidebar).queryByText('getting-started.md')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().has('C:/wiki/notes/guides/getting-started.md')).toBe(false)
  })

  it('renders workspace view inside the left sidebar when no workspace is open, supports open-folder button, opens recent workspace directly, and simplifies explorer header', async () => {
    const user = userEvent.setup()
    const favoriteAlpha = addFavoriteWorkspace(
      [],
      'C:/wiki/alpha',
      'alpha',
      '2026-11-14T00:00:00.000Z'
    )
    const { api } = createInMemoryWikiApi(
      {
        favoriteWorkspaces: favoriteAlpha,
        recentWorkspaces: ['C:/wiki/deleted-ws', 'C:/wiki/gamma']
      },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )
    const selectFolderSpy = vi.fn(api.workspace.selectFolder)
    api.workspace.selectFolder = selectFolderSpy
    window.wikiApi = api

    render(<App />)
    await screen.findByText('열린 워크스페이스 없음')
    await waitFor(async () => {
      const cfg = await api.config.get()
      expect(cfg.recentWorkspaces).toEqual(['C:/wiki/gamma'])
    })

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(workspaceView).getByText('열린 워크스페이스 없음')).toBeInTheDocument()
    expect(
      within(workspaceView).getByText(/폴더를 열거나.*선택하세요/i)
    ).toBeInTheDocument()
    expect(
      within(workspaceView).queryByRole('button', { name: /^(?:즐겨찾기 추가|즐겨찾기 해제)$/ })
    ).not.toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: /★\s*alpha/i })).toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: /gamma/i })).toBeInTheDocument()
    expect(within(workspaceView).queryByRole('button', { name: /deleted-ws/i })).not.toBeInTheDocument()

    // Clicking '폴더 열기...' triggers the same folder selection handler as File > Open Folder
    await user.click(within(workspaceView).getByRole('button', { name: '폴더 열기...' }))
    expect(selectFolderSpy).toHaveBeenCalledTimes(1)
    const explorerAfterOpen = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorerAfterOpen).findByText('alpha.md')).toBeInTheDocument()

    // Return to Workspace View and click recent workspace directly -> opens gamma and transitions to Explorer
    await clickActivityBarButton(user, '워크스페이스')
    const reopenedWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(reopenedWorkspaceView).getByRole('button', { name: /gamma/i }))

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('gamma.md')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '워크스페이스 뷰' })).not.toBeInTheDocument()

    // Explorer header only displays workspace name (with path tooltip) and create/refresh actions
    const titleEl = within(sidebar).getByText('gamma')
    expect(titleEl).toHaveAttribute('title', 'C:/wiki/gamma')
    expect(
      within(sidebar).queryByRole('button', { name: /워크스페이스 전환/i })
    ).not.toBeInTheDocument()
    expect(
      within(sidebar).queryByRole('button', { name: /즐겨찾기 추가|즐겨찾기 해제/i })
    ).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /새 파일/i })).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /새 폴더/i })).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /새로고침/i })).toBeInTheDocument()
  })

  it('displays current workspace card with favorite toggle in workspace view, highlights active item, confirms unsaved edits, and keeps workspace view on cancel or error', async () => {
    const user = userEvent.setup()
    const favoriteAlpha = addFavoriteWorkspace(
      [],
      'C:/wiki/alpha',
      'alpha',
      '2026-11-14T00:00:00.000Z'
    )
    const { api } = createInMemoryWikiApi(
      {
        autoSave: false,
        favoriteWorkspaces: favoriteAlpha,
        recentWorkspaces: ['C:/wiki/recent-ws', 'C:/wiki/broken-ws']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\recent-ws': { 'recent.md': '# Recent' }
        }
      }
    )
    const defaultOpen = api.workspace.open
    api.workspace.open = async (rootPath) => {
      if (rootPath.replace(/\\/g, '/') === 'C:/wiki/broken-ws') {
        throw new Error('Workspace open failed')
      }
      return defaultOpen(rootPath)
    }
    window.wikiApi = api

    render(<App />)

    // Startup restore opens recent-ws automatically into Explorer View; switch to Workspace View to verify switcher flows
    const initialExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(initialExplorer).findByText('recent.md')).toBeInTheDocument()
    await clickActivityBarButton(user, '워크스페이스')

    // Switch failure keeps Workspace View active and displays error banner
    const initialWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(initialWorkspaceView).getByRole('button', { name: /broken-ws/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace open failed')
    expect(screen.getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()

    // Open favorite workspace from Workspace View -> switches to Explorer
    await user.click(within(initialWorkspaceView).getByRole('button', { name: /★\s*alpha/i }))
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('alpha.md')).toBeInTheDocument()

    // Edit alpha.md so workspace has unsaved changes
    await user.click(within(explorer).getByText('alpha.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), ' unsaved')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Open Workspace View -> shows current workspace name/path, favorite toggle (pressed), open folder, and active highlight
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(workspaceView).getByText('C:/wiki/alpha')).toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: '폴더 열기...' })).toBeInTheDocument()
    const activeFavoriteBtn = within(workspaceView).getByRole('button', { name: '즐겨찾기 해제' })
    expect(activeFavoriteBtn).toHaveAttribute('aria-pressed', 'true')
    expect(activeFavoriteBtn).toHaveAttribute('title', '즐겨찾기 해제')
    const activeAlphaBtn = within(workspaceView).getByRole('button', { name: /★\s*alpha/i })
    expect(activeAlphaBtn).toHaveAttribute('aria-current', 'true')
    expect(activeAlphaBtn).toHaveClass('is-active')

    // Switch to recent workspace -> triggers unsaved confirmation dialog; cancel keeps Workspace View & current workspace
    await user.click(within(workspaceView).getByRole('button', { name: /recent-ws/i }))
    const cancelDialog = await screen.findByRole('alertdialog')
    await user.click(within(cancelDialog).getByRole('button', { name: '취소' }))
    expect(screen.getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Alpha unsaved')

    // Retry switching to recent workspace and discard unsaved changes -> transitions to Explorer
    await user.click(within(workspaceView).getByRole('button', { name: /recent-ws/i }))
    const discardDialog = await screen.findByRole('alertdialog')
    await user.click(within(discardDialog).getByRole('button', { name: /버리고 이동/i }))

    const nextExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(nextExplorer).findByText('recent.md')).toBeInTheDocument()

    // Return to Workspace View -> shows recent-ws current card, unpressed favorite toggle, and highlighted recent item
    await clickActivityBarButton(user, '워크스페이스')
    const nextWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(nextWorkspaceView).getByText('C:/wiki/recent-ws')).toBeInTheDocument()
    const nextFavoriteBtn = within(nextWorkspaceView).getByRole('button', { name: '즐겨찾기 추가' })
    expect(nextFavoriteBtn).toHaveAttribute('aria-pressed', 'false')
    expect(nextFavoriteBtn).toHaveAttribute('title', '즐겨찾기 추가')
    expect(within(nextWorkspaceView).getByRole('button', { name: /^recent-ws$/i })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('toggles current workspace in favorites and switches or removes favorites directly from workspace view', async () => {
    const user = userEvent.setup()
    const favoriteBeta = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { favoriteWorkspaces: favoriteBeta },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('alpha.md')).toBeInTheDocument()

    // Switch to Workspace View and add alpha to favorites
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView).getByRole('button', { name: '즐겨찾기 추가' }))
    await waitFor(() => {
      expect(within(workspaceView).getByRole('button', { name: '즐겨찾기 해제' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    })
    expect(within(workspaceView).getByRole('button', { name: /★\s*alpha/i })).toHaveAttribute(
      'aria-current',
      'true'
    )

    // Click ★ beta in Workspace View to switch workspaces and transition to Explorer
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*beta/i }))

    const betaExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(betaExplorer).findByText('beta.md')).toBeInTheDocument()
    expect(within(betaExplorer).queryByText('alpha.md')).not.toBeInTheDocument()

    // Return to Workspace View and remove beta from favorites via × button
    await clickActivityBarButton(user, '워크스페이스')
    const updatedWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    const removeBetaBtn = within(updatedWorkspaceView).getByRole('button', {
      name: 'beta 즐겨찾기 해제'
    })
    expect(removeBetaBtn).toHaveAttribute('title', 'beta 즐겨찾기 해제')
    await user.click(removeBetaBtn)

    await waitFor(() => {
      expect(
        within(updatedWorkspaceView).getByRole('button', { name: '즐겨찾기 추가' })
      ).toHaveAttribute('aria-pressed', 'false')
    })
    expect(
      within(updatedWorkspaceView).queryByRole('button', { name: /★\s*beta/i })
    ).not.toBeInTheDocument()
  })

  it('does not overwrite user-selected activity bar view when async config resolves or workspace opens from another view', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { recentWorkspaces: ['C:/wiki/alpha'] },
      {
        selectedFolder: 'C:\\wiki\\beta',
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' }
        }
      }
    )
    let resolveConfigGet!: (value: Awaited<ReturnType<typeof api.config.get>>) => void
    const defaultConfigGet = api.config.get
    api.config.get = async () => {
      const resolved = await defaultConfigGet()
      return await new Promise((resolve) => {
        resolveConfigGet = () => resolve(resolved)
      })
    }
    const openSpy = vi.spyOn(api.workspace, 'open')
    window.wikiApi = api

    render(<App />)
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    expect(within(activityBar).getByRole('button', { name: '워크스페이스' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // User switches to Git view before config.get() resolves
    await clickActivityBarButton(user, 'Git')
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()

    // Resolving config.get() triggers startup restore, which must NOT overwrite the user's Git view selection
    await act(async () => {
      resolveConfigGet(undefined as never)
    })
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('C:/wiki/alpha')
    })
    expect(within(activityBar).getByRole('button', { name: 'Git' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()

    // Opening another folder while user is in Git view preserves Git view instead of forcing Explorer
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(within(activityBar).getByRole('button', { name: 'Git' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()
  })

  it('tracks dirty ● indicator, saves manually with Ctrl+S, and auto-saves when autoSave is enabled', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false, autoSaveDelayMs: 120 },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'note.md': '# Initial'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('note.md'))

    const editor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editor)).toBe('# Initial')
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    // Edit content -> dirty ● appears
    appendRawEditorText(editor, '\nUpdated line')
    expect(screen.getByTestId('dirty-indicator')).toHaveTextContent('●')

    // Ctrl+S saves and clears dirty ●
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/docs/note.md')).toBe('# Initial\nUpdated line')

    // Enable auto-save in settings panel
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const autoSaveToggle = await screen.findByRole('checkbox', { name: /자동 저장/i })
    await user.click(autoSaveToggle)
    await waitFor(() => {
      expect(autoSaveToggle).toBeChecked()
    })

    // Type again and wait for debounced auto-save
    appendRawEditorText(editor, '\nAuto saved')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })

    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/docs/note.md')).toBe(
      '# Initial\nUpdated line\nAuto saved'
    )
  })

  it('validates config.json when editing and saving directly, applying valid changes immediately and rejecting invalid JSON without corrupting config', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light', autoSave: false })
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const editor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editor)).toContain('"theme": "light"')

    // Invalid JSON must be rejected and keep dirty indicator
    setRawEditorText(editor, '{ broken json')
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })

    expect(await screen.findByRole('alert')).toHaveTextContent(/JSON/i)
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()
    expect((await api.config.get()).theme).toBe('light')

    // Valid updated config.json applies immediately to the running app
    const nextConfigJson = JSON.stringify(
      {
        version: 1,
        theme: 'dark',
        autoSave: true,
        autoSaveDelayMs: 500,
        showHeadingNumbers: true,
        favoriteWorkspaces: [],
        recentWorkspaces: []
      },
      null,
      2
    )
    setRawEditorText(editor, nextConfigJson)
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect((await api.config.get()).autoSave).toBe(true)
  })

  it('prompts before leaving unsaved edits, syncs active document path on rename, and refreshes on workspace watch events', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, emitWorkspaceChange, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\sync',
        workspaces: {
          'C:\\wiki\\sync': {
            'first.md': '# First',
            'second.md': '# Second'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('first.md'))
    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, ' edited')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Clicking second.md opens a second tab while first.md stays open and dirty; closing first.md prompts -> 저장 후 닫기
    await user.click(within(sidebar).getByText('second.md'))
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Second')
    await user.click(screen.getByRole('button', { name: 'first.md 탭 닫기' }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 닫기/i }))

    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Second')
      expect(screen.queryByRole('tab', { name: /first\.md/i })).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/sync/first.md')).toBe('# First edited')

    // Renaming active file updates its path so saving writes to the renamed file
    const secondItem = within(sidebar).getByRole('treeitem', { name: 'second.md' })
    secondItem.focus()
    fireEvent.keyDown(secondItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'renamed-second.md{Enter}')

    await waitFor(() => {
      expect(screen.getByText('renamed-second.md', { selector: '.editor-doc-title' })).toBeInTheDocument()
    })
    appendRawEditorText(screen.getByTestId('document-editor'), '!')
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(getFilesSnapshot().get('C:/wiki/sync/renamed-second.md')).toBe('# Second!')
    })

    // External filesystem creation triggers tree refresh via workspace:changed
    await api.workspace.createEntry('.', 'external-added.md', 'file', '# External')
    emitWorkspaceChange({
      rootPath: 'C:/wiki/sync',
      eventType: 'rename',
      relativePath: 'external-added.md'
    })
    expect(await within(sidebar).findByText('external-added.md')).toBeInTheDocument()
  })

  it('allows returning selection to workspace root, disables auto-save on config.json and paused dirty dialogs, and blocks concurrent Ctrl+S saves', async () => {
    const user = userEvent.setup()
    let writeCount = 0
    let resolveWrite!: () => void
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 60 },
      {
        selectedFolder: 'C:\\wiki\\edge',
        workspaces: {
          'C:\\wiki\\edge': {
            'nested/inner.md': '# Inner',
            'other.md': '# Other'
          }
        }
      }
    )
    const origWriteFile = api.workspace.writeFile
    api.workspace.writeFile = async (filePath, content) => {
      writeCount += 1
      if (writeCount === 1) {
        return new Promise<void>((resolve) => {
          resolveWrite = () => {
            void origWriteFile(filePath, content).then(resolve)
          }
        })
      }
      return origWriteFile(filePath, content)
    }
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    // Select nested item, then click empty tree area to clear selection and create at workspace root
    await user.click(await within(sidebar).findByText('nested'))
    expect(await within(sidebar).findByText('inner.md')).toBeInTheDocument()
    await user.click(within(sidebar).getByText('inner.md'))
    await user.click(within(sidebar).getByRole('tree'))
    await user.click(within(sidebar).getByRole('button', { name: /새 파일/i }))
    await user.type(await within(sidebar).findByLabelText('새 파일 이름'), 'top-level.md{Enter}')
    expect(await within(sidebar).findByText('top-level.md')).toBeInTheDocument()

    // Rapid Ctrl+S while save is in flight must NOT fire overlapping writeFile calls
    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, 'hello')
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    expect(writeCount).toBe(1)
    resolveWrite()
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })

    // While dirty-confirmation dialog is open, auto-save is paused and must not auto-write before choice
    appendRawEditorText(editor, ' unsaved')
    await user.click(screen.getByRole('button', { name: 'top-level.md 탭 닫기' }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(writeCount).toBe(1)
    await user.click(within(dirtyDialog).getByRole('button', { name: /버리고 닫기/i }))
    await user.click(within(sidebar).getByText('other.md'))
    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Other')
    })

    // Auto-save must NOT fire on invalid mid-edit config.json
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))
    const configEditor = await screen.findByTestId('document-editor')
    setRawEditorText(configEditor, '{ invalid json')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('waits for an in-flight save before completing 저장 후 이동 without dropping navigation', async () => {
    const user = userEvent.setup()
    let releaseFirstSave!: () => void
    let callNum = 0
    const nextFav = addFavoriteWorkspace(
      [],
      'C:/wiki/inflight-next',
      'inflight-next',
      '2026-11-14T00:00:00.000Z'
    )
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 60, favoriteWorkspaces: nextFav },
      {
        selectedFolder: 'C:\\wiki\\inflight',
        workspaces: {
          'C:\\wiki\\inflight': {
            'a.md': '# A',
            'b.md': '# B'
          },
          'C:\\wiki\\inflight-next': {
            'next.md': '# Next'
          }
        }
      }
    )
    const origWrite = api.workspace.writeFile
    api.workspace.writeFile = async (filePath, content) => {
      callNum += 1
      if (callNum === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstSave = () => {
            void origWrite(filePath, content).then(resolve)
          }
        })
      }
      return origWrite(filePath, content)
    }
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('a.md'))
    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, ' v1')

    // Wait for auto-save to enter in-flight state
    await waitFor(() => expect(callNum).toBe(1))
    // Type more while first save is still in flight, then switch workspace via Workspace View and choose 저장 후 이동
    appendRawEditorText(editor, ' v2')
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*inflight-next/i }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 이동/i }))

    releaseFirstSave()
    const updatedSidebar = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(updatedSidebar).findByText('next.md')).toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/inflight/a.md')).toBe('# A v1 v2')
  })
})

describe('Multi-tab and 2-pane Split View layout', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('omits split mode buttons (단일, 좌우 분할, 상하 분할) from the app header', async () => {
    const { api } = createInMemoryWikiApi()
    window.wikiApi = api

    render(<App />)
    await screen.findByText('열린 워크스페이스 없음')

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '화면 분할' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '단일 화면' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '좌우 분할' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '상하 분할' })).not.toBeInTheDocument()
  })

  it('opens multiple tabs, switches tabs, closes via X and middle-click, and prompts before closing the last tab of a dirty buffer', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\tabs',
        workspaces: {
          'C:\\wiki\\tabs': {
            'one.md': '# One',
            'two.md': '# Two',
            'three.md': '# Three'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('one.md'))
    await user.click(within(sidebar).getByText('two.md'))
    await user.click(within(sidebar).getByText('three.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    const tabs = within(primaryPane).getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.map((t) => t.textContent)).toEqual(['one.md', 'two.md', 'three.md'])
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')

    // Edit three.md so it becomes dirty
    appendRawEditorText(within(primaryPane).getByTestId('document-editor'), ' edited')
    expect(within(tabs[2]).getByTestId('tab-dirty-indicator')).toHaveTextContent('●')

    // Click one.md tab to switch cleanly without losing three.md edits
    await user.click(tabs[0])
    expect(within(primaryPane).getByRole('tab', { name: /one\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toBe('# One')

    // Middle-click clean two.md tab closes it immediately
    const twoTab = within(primaryPane).getByRole('tab', { name: /two\.md/i })
    fireEvent(twoTab, new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(within(primaryPane).queryByRole('tab', { name: /two\.md/i })).not.toBeInTheDocument()

    // Close dirty three.md via X button -> opens confirmation dialog -> choose 저장 후 닫기
    await user.click(within(primaryPane).getByRole('button', { name: 'three.md 탭 닫기' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /저장 후 닫기/i }))

    await waitFor(() => {
      expect(within(primaryPane).queryByRole('tab', { name: /three\.md/i })).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/tabs/three.md')).toBe('# Three edited')
  })

  it('supports horizontal/vertical split view, resizing divider, context menu move/duplicate, real-time shared buffer sync, and auto-collapse', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\split',
        workspaces: {
          'C:\\wiki\\split': {
            'shared.md': '# Shared',
            'side.md': '# Side'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('shared.md'))
    await user.click(within(sidebar).getByText('side.md'))

    const workspaceEl = screen.getByTestId('pane-workspace')
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')

    // Context menu "분할 영역으로 이동" moves side.md to secondary and opens horizontal split
    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /side\.md/i }))
    const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(1)
    expect(within(secondaryPane).getByRole('tab', { name: /side\.md/i })).toBeInTheDocument()

    // Duplicate shared.md into secondary pane so both panes show the same file simultaneously
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /shared\.md/i }))
    const dupMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(dupMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    expect(within(secondaryPane).getByRole('tab', { name: /shared\.md/i })).toBeInTheDocument()

    // Editing in primary immediately syncs content and dirty ● to secondary
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    const secondaryEditor = within(secondaryPane).getByTestId('document-editor')
    appendRawEditorText(primaryEditor, ' synced!')

    expect(getRawEditorText(secondaryEditor)).toBe('# Shared synced!')
    expect(within(primaryPane).getByTestId('dirty-indicator')).toHaveTextContent('●')
    expect(within(secondaryPane).getByTestId('dirty-indicator')).toHaveTextContent('●')

    // Closing one split tab of a dirty file does NOT prompt because the other pane still holds the buffer
    await user.click(within(secondaryPane).getByRole('button', { name: 'shared.md 탭 닫기' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(primaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Duplicate back, then save in secondary -> clears dirty ● in BOTH panes
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /shared\.md/i }))
    const dupMenu2 = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(dupMenu2).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    const syncedSecondaryEditor = within(secondaryPane).getByTestId('document-editor')
    fireEvent.keyDown(syncedSecondaryEditor, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/split/shared.md')).toBe('# Shared synced!')

    // Switch split direction to vertical by dragging a tab to the vertical drop zone and resize splitter via keyboard and pointer drag
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /side\.md/i }))
    fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')

    const divider = screen.getByRole('separator', { name: '화면 분할 크기 조절' })
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal')
    expect(divider).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(divider, { key: 'ArrowDown' })
    expect(divider).toHaveAttribute('aria-valuenow', '55')

    vi.spyOn(workspaceEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    fireEvent.mouseDown(divider, { clientY: 330 })
    fireEvent.mouseMove(window, { clientY: 180 })
    fireEvent.mouseUp(window)
    expect(divider).toHaveAttribute('aria-valuenow', '30')

    // Closing all tabs in secondary auto-collapses back to single pane
    await user.click(within(secondaryPane).getByRole('button', { name: 'shared.md 탭 닫기' }))
    await user.click(within(secondaryPane).getByRole('button', { name: 'side.md 탭 닫기' }))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
  })

  it('supports drag-and-drop reordering and moving tabs between panes', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\dnd',
        workspaces: {
          'C:\\wiki\\dnd': {
            'a.md': '# A',
            'b.md': '# B',
            'c.md': '# C'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('a.md'))
    await user.click(within(sidebar).getByText('b.md'))
    await user.click(within(sidebar).getByText('c.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    const cTab = within(primaryPane).getByRole('tab', { name: /c\.md/i })
    const aTab = within(primaryPane).getByRole('tab', { name: /a\.md/i })

    // Reorder c.md before a.md within primary tab bar
    fireEvent.dragStart(cTab)
    fireEvent.drop(aTab)
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'c.md',
      'a.md',
      'b.md'
    ])

    // Drag b.md onto horizontal split drop zone in single mode -> creates horizontal split with b.md
    const bTab = within(primaryPane).getByRole('tab', { name: /b\.md/i })
    fireEvent.dragStart(bTab)
    const horizontalDropZone = await screen.findByTestId('split-drop-zone-horizontal')
    expect(screen.getByTestId('split-drop-zone-vertical')).toBeInTheDocument()
    fireEvent.drop(horizontalDropZone)

    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /b\.md/i })).not.toBeInTheDocument()
  })

  it('supports vertical drag split from single mode, orientation switching in split mode, and auto-collapse focus preservation', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\drag-split',
        workspaces: {
          'C:\\wiki\\drag-split': {
            'a.md': '# A',
            'b.md': '# B',
            'c.md': '# C'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    // With only 1 tab open in single mode, dragging must NOT show split drop zones
    await user.click(await within(sidebar).findByText('a.md'))
    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /a\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-horizontal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()
    fireEvent.dragEnd(within(primaryPane).getByRole('tab', { name: /a\.md/i }))

    // Open b.md (2 tabs) -> dragging shows both horizontal and vertical drop zones; drop on vertical
    await user.click(within(sidebar).getByText('b.md'))
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /b\.md/i }))
    expect(screen.getByTestId('split-drop-zone-horizontal')).toBeInTheDocument()
    const verticalDropZone = screen.getByTestId('split-drop-zone-vertical')
    fireEvent.drop(verticalDropZone)

    const workspaceEl = screen.getByTestId('pane-workspace')
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md'])
    expect(within(secondaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['b.md'])

    // In vertical mode with 1 tab in primary, dragging primary tab shows ONLY horizontal drop zone & switches orientation without collapsing
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /a\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()
    const switchHorizontalZone = screen.getByTestId('split-drop-zone-horizontal')
    fireEvent.drop(switchHorizontalZone)

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md'])
    expect(within(secondaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['b.md'])

    // In horizontal mode, dragging secondary tab shows ONLY vertical drop zone & switches back to vertical
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /b\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-horizontal')).not.toBeInTheDocument()
    fireEvent.drop(screen.getByTestId('split-drop-zone-vertical'))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // With 2 tabs in primary (open c.md in primary), dragging c.md to horizontal drop zone moves c.md to secondary AND switches to horizontal
    await user.click(within(primaryPane).getByRole('tab', { name: /a\.md/i }))
    await user.click(within(sidebar).getByText('c.md'))
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md', 'c.md'])

    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /c\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()
    fireEvent.drop(screen.getByTestId('split-drop-zone-horizontal'))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md'])
    expect(within(secondaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'b.md',
      'c.md'
    ])
    expect(within(secondaryPane).getByRole('tab', { name: /c\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Moving all tabs from secondary to primary auto-collapses to single mode while preserving active focus on c.md
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /b\.md/i }))
    fireEvent.drop(primaryPane)
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')

    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /c\.md/i }))
    fireEvent.drop(primaryPane)

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /c\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# C')
  })

  it('keeps at most 2 editor instances mounted when 25+ tabs are open and restores cursor/scroll on tab switch', async () => {
    const user = userEvent.setup()
    const files: Record<string, string> = {}
    for (let i = 1; i <= 25; i += 1) {
      const num = String(i).padStart(2, '0')
      files[`doc-${num}.md`] = `# Document ${num}\nLine 2 content for testing cursor and scroll`
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\many',
        workspaces: {
          'C:\\wiki\\many': files
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    for (let i = 1; i <= 25; i += 1) {
      const num = String(i).padStart(2, '0')
      await user.click(await within(sidebar).findByText(`doc-${num}.md`))
    }

    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(25)
    // In single pane, only 1 editor DOM node is mounted regardless of 25 open tabs
    expect(screen.getAllByTestId('document-editor')).toHaveLength(1)

    // Switch to doc-01.md, set selection range and scrollTop, then switch to doc-02.md and back
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-01.md' }))
    const editor01 = within(primaryPane).getByTestId('document-editor')
    setRawEditorSelection(editor01, 4, 11)
    const scroller01 = getRawEditorScroller(editor01)
    scroller01.scrollTop = 180
    fireEvent.scroll(scroller01)

    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-02.md' }))
    expect(screen.getAllByTestId('document-editor')).toHaveLength(1)
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toContain(
      '# Document 02'
    )

    // Switch back to doc-01.md -> restored cursor & scrollTop
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-01.md' }))
    const restored01 = within(primaryPane).getByTestId('document-editor')
    expect(getRawEditorSelection(restored01)).toEqual({ start: 4, end: 11 })
    expect(getRawEditorScroller(restored01).scrollTop).toBe(180)

    // Move doc-25.md to secondary pane -> still at most 2 editor DOM instances across 25 tabs
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: 'doc-25.md' }))
    const menu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(menu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(screen.getAllByTestId('document-editor')).toHaveLength(2)
  })

  it('syncs file renames and deletions across split panes and keeps config.json tab open across workspace switches', async () => {
    const user = userEvent.setup()
    const nextFav = addFavoriteWorkspace([], 'C:/wiki/ws2', 'ws2', '2026-11-14T00:00:00.000Z')
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { favoriteWorkspaces: nextFav },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'target.md': '# Target',
            'keep.md': '# Keep'
          },
          'C:\\wiki\\ws2': {
            'ws2.md': '# WS2'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('target.md'))
    await user.click(within(sidebar).getByText('keep.md'))

    // Open config.json as its own tab too
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()

    // Duplicate target.md to secondary pane
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /target\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')

    // Rename target.md -> updated.md updates tabs in BOTH panes
    const targetItem = within(sidebar).getByRole('treeitem', { name: 'target.md' })
    targetItem.focus()
    fireEvent.keyDown(targetItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'updated.md{Enter}')

    expect(await within(primaryPane).findByRole('tab', { name: /updated\.md/i })).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('tab', { name: /updated\.md/i })).toBeInTheDocument()

    // Delete updated.md removes tab in both panes and auto-collapses secondary
    fireEvent.contextMenu(within(sidebar).getByText('updated.md'))
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: /삭제/i })
    )
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i })
    )

    await waitFor(() => {
      expect(within(primaryPane).queryByRole('tab', { name: /updated\.md/i })).not.toBeInTheDocument()
      expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    })

    // Switching workspace closes workspace tabs (keep.md) while preserving config.json tab
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*ws2/i }))

    const updatedSidebar = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(updatedSidebar).findByText('ws2.md')).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /keep\.md/i })).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()
  })

  it('preserves unfocused split pane cursor selection when the other pane edits and scrolls', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'doc.md': 'Hello World!'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('doc.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /doc\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )

    const secondaryPane = screen.getByTestId('pane-secondary')
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    const secondaryEditor = within(secondaryPane).getByTestId('document-editor')

    secondaryEditor.focus()
    setRawEditorSelection(secondaryEditor, 2, 5)

    primaryEditor.focus()
    const secondaryScroller = getRawEditorScroller(secondaryEditor)
    secondaryScroller.scrollTop = 90
    fireEvent.scroll(secondaryScroller)

    setRawEditorText(primaryEditor, 'Hello World! Edited')

    expect(getRawEditorText(secondaryEditor)).toBe('Hello World! Edited')
    expect(getRawEditorSelection(secondaryEditor)).toEqual({ start: 2, end: 5 })
    expect(getRawEditorScroller(secondaryEditor).scrollTop).toBe(90)
  })

  it('stops auto-save retries after a write failure until the next edit', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 40 },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'fail.md': '# Start'
          }
        }
      }
    )
    const writeSpy = vi
      .spyOn(api.workspace, 'writeFile')
      .mockRejectedValueOnce(new Error('Disk full'))
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('fail.md'))

    const editor = screen.getByTestId('document-editor')
    setRawEditorText(editor, '# First failed edit')

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full')
    expect(writeSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(writeSpy).toHaveBeenCalledTimes(1)

    setRawEditorText(editor, '# Recovered edit')
    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
  })

  it('ignores Ctrl+S shortcuts while a ConfirmDialog is open', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'dirty.md': 'initial'
          }
        }
      }
    )
    const writeSpy = vi.spyOn(api.workspace, 'writeFile')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('dirty.md'))

    const editor = screen.getByTestId('document-editor')
    setRawEditorText(editor, 'unsaved changes')

    await user.click(screen.getByRole('button', { name: 'dirty.md 탭 닫기' }))
    const dialog = await screen.findByRole('alertdialog')

    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(dialog, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    expect(writeSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('clears saving state cleanly when renaming a file while a save is in flight', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'slow.md': '# Slow'
          }
        }
      }
    )
    let resolveWrite!: () => void
    vi.spyOn(api.workspace, 'writeFile').mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('slow.md'))

    setRawEditorText(screen.getByTestId('document-editor'), '# Slow edited')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(screen.getByText('저장 중...')).toBeInTheDocument()

    const slowItem = within(sidebar).getByRole('treeitem', { name: 'slow.md' })
    slowItem.focus()
    fireEvent.keyDown(slowItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'fast.md{Enter}')

    expect(await screen.findByRole('tab', { name: /fast\.md/i })).toBeInTheDocument()

    await act(async () => {
      resolveWrite()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText('저장됨')).toBeInTheDocument()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
  })

  it('preserves active secondary tab focus when collapsing split view to single mode', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'a.md': '# A',
            'b.md': '# B'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('a.md'))
    await user.click(screen.getByText('b.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /b\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역으로 이동'
      })
    )

    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Closing the sole primary tab promotes secondary into primary and preserves focus on b.md
    await user.click(within(primaryPane).getByRole('button', { name: 'a.md 탭 닫기' }))

    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /b\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# B')
  })
})

describe('Three-mode markdown editor, split mode sync, and table editing', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('supports Left Raw + Right Preview live sync in split view and lossless Raw <-> WYSIWYG <-> Preview roundtrips', async () => {
    const user = userEvent.setup()
    const initialMd = '# Title\n\n*   kept   spacing\n\n- [x] Done'
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\modes',
        workspaces: {
          'C:\\wiki\\modes': {
            'doc.md': initialMd
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('doc.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /doc\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )

    const secondaryPane = screen.getByTestId('pane-secondary')
    const secondaryModeGroup = within(secondaryPane).getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(secondaryModeGroup).getByRole('button', { name: 'Preview' }))

    expect(within(secondaryPane).getByLabelText('마크다운 미리보기')).toBeInTheDocument()
    expect(
      within(secondaryPane).getByRole('heading', { level: 1, name: 'Title' })
    ).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('checkbox')).toBeChecked()

    // Edit Left Raw -> Right Preview reflects edit live via shared DocumentBufferStore
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    appendRawEditorText(primaryEditor, '\n\nLive Paragraph')

    expect(within(secondaryPane).getByText('Live Paragraph')).toBeInTheDocument()
    expect(within(primaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(within(secondaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Save via Ctrl+S
    fireEvent.keyDown(primaryEditor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/modes/doc.md')).toContain('Live Paragraph')

    // Roundtrip Raw -> 위지윅 -> Preview -> Split -> Raw without editing must keep buffer clean and formatting intact
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '2', ctrlKey: true })
    expect(
      within(primaryPane).getByRole('toolbar', { name: '위지윅 서식 툴바' })
    ).toBeInTheDocument()

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '3', ctrlKey: true })
    expect(within(primaryPane).getByLabelText('마크다운 미리보기')).toBeInTheDocument()

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    expect(within(primaryPane).getByTestId('split-markdown-preview')).toBeInTheDocument()
    expect(within(primaryPane).queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    const roundtrippedRaw = within(primaryPane).getByTestId('document-editor')
    expect(getRawEditorText(roundtrippedRaw)).toContain('*   kept   spacing')
    expect(within(primaryPane).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
  })

  it('supports GFM table insertion and row/column add/delete in both Raw mode and WYSIWYG mode', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\tables',
        workspaces: {
          'C:\\wiki\\tables': {
            'raw-table.md': '',
            'wysiwyg-table.md': '# Table Demo\n\n'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    // 1) Raw mode table manipulation via TableMarkdownManipulator toolbar
    await user.click(await within(sidebar).findByText('raw-table.md'))
    const rawToolbar = screen.getByRole('toolbar', { name: 'Raw 표 편집 툴바' })
    await user.click(within(rawToolbar).getByRole('button', { name: '표 삽입' }))

    const rawEditor = screen.getByTestId('document-editor')
    const insertedText = getRawEditorText(rawEditor)
    expect(insertedText).toContain('| 열 1 | 열 2 | 열 3 |')

    const insertedLines = insertedText.split('\n')
    const bodyCellOffset = insertedLines[0].length + 1 + insertedLines[1].length + 1 + 2
    setRawEditorSelection(rawEditor, bodyCellOffset, bodyCellOffset)
    await user.click(within(rawToolbar).getByRole('button', { name: '행 아래 추가' }))
    await user.click(within(rawToolbar).getByRole('button', { name: '열 우 추가' }))

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    const savedRawTable = getFilesSnapshot().get('C:/wiki/tables/raw-table.md') ?? ''
    const rawTableLines = savedRawTable
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('|'))
    // Initially 4 lines (header + separator + 2 body rows) -> +1 row = 5 lines, 3 cols -> +1 col = 4 cols
    expect(rawTableLines).toHaveLength(5)
    expect(rawTableLines[0].split('|').slice(1, -1)).toHaveLength(4)

    // 2) WYSIWYG mode table insertion + row/column add/delete
    await user.click(within(sidebar).getByText('wysiwyg-table.md'))
    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))

    const formatToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
    await user.click(within(formatToolbar).getByRole('button', { name: '표 삽입' }))

    const tableToolbar = await screen.findByRole('toolbar', { name: '표 편집 툴바' })
    await user.click(within(tableToolbar).getByRole('button', { name: '행 아래 추가' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '열 우 추가' }))

    const wysiwygEl = screen.getByTestId('document-editor')
    const tableEl = wysiwygEl.querySelector('table')
    expect(tableEl).not.toBeNull()
    expect(tableEl?.querySelectorAll('tr')).toHaveLength(4)
    expect(tableEl?.querySelector('tr')?.querySelectorAll('th, td')).toHaveLength(4)

    await user.click(within(tableToolbar).getByRole('button', { name: '현재 행 삭제' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '현재 열 삭제' }))

    expect(wysiwygEl.querySelectorAll('table tr')).toHaveLength(3)
    expect(wysiwygEl.querySelector('table tr')?.querySelectorAll('th, td')).toHaveLength(3)

    fireEvent.keyDown(wysiwygEl, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/tables/wysiwyg-table.md')).toContain('|')

    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    const previewTable = screen.getByTestId('document-editor').querySelector('table')
    expect(previewTable?.querySelectorAll('tr')).toHaveLength(3)
  })

  it('sanitizes XSS payloads in Preview mode and syncs editor theme across Light and Dark modes', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\xss',
        workspaces: {
          'C:\\wiki\\xss': {
            'xss.md':
              '# Safe Title\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)" />\n\n[Bad](javascript:alert(3))\n\n[Good](https://example.com)'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('xss.md'))

    // Verify theme sync on CodeMirror 6 in Raw mode
    expect(document.querySelector('.cm-editor')?.getAttribute('data-theme-mode')).toBe('light')
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
      expect(document.querySelector('.cm-editor')?.getAttribute('data-theme-mode')).toBe('dark')
    })

    // Switch to Preview and verify XSS sanitization
    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: 'Preview'
      })
    )
    const previewEl = screen.getByTestId('document-editor')
    expect(previewEl.querySelector('script')).toBeNull()
    const imgEl = previewEl.querySelector('img')
    expect(imgEl?.getAttribute('onerror')).toBeNull()
    const badLink = screen.getByText('Bad').closest('a')
    expect(badLink?.getAttribute('href')).toBeNull()
    expect(screen.getByRole('link', { name: 'Good' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
  })
})

describe('Mermaid rendering, Outline TOC, and hybrid heading auto-numbering', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
    defaultMermaidRenderer.clearCache()
    mermaidMockState.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders mermaid diagrams in Preview and WYSIWYG, syncs theme via cache, isolates syntax errors, and preserves roundtrip', async () => {
    const user = userEvent.setup()
    const diagramDoc = [
      '# Architecture',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[Start] --> B[End]',
      '```',
      '',
      '```mermaid',
      'SYNTAX_ERROR broken node',
      '```'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: true },
      {
        selectedFolder: 'C:\\wiki\\mermaid',
        workspaces: {
          'C:\\wiki\\mermaid': {
            'diagram.md': diagramDoc
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('diagram.md'))

    // Preview mode renders valid Mermaid SVG and isolates broken block without crashing
    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))

    await waitFor(() => {
      const svgs = screen.getByTestId('document-editor').querySelectorAll('svg[data-mermaid-theme]')
      expect(svgs).toHaveLength(1)
      expect(svgs[0].getAttribute('data-mermaid-theme')).toBe('default')
    })

    const errorAlert = screen.getByRole('alert')
    expect(errorAlert.textContent).toContain('Syntax error in Mermaid graph')
    expect(errorAlert.textContent).toContain('SYNTAX_ERROR broken node')

    // Switch theme Light -> Dark -> Light: Dark re-renders cleanly, Light back hits cache
    const callsAfterInitial = mermaidMockState.render.mock.calls.length
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      const svg = screen.getByTestId('document-editor').querySelector('svg[data-mermaid-theme]')
      expect(svg?.getAttribute('data-mermaid-theme')).toBe('dark')
    })

    const callsAfterDark = mermaidMockState.render.mock.calls.length
    expect(callsAfterDark).toBeGreaterThan(callsAfterInitial)

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      const svg = screen.getByTestId('document-editor').querySelector('svg[data-mermaid-theme]')
      expect(svg?.getAttribute('data-mermaid-theme')).toBe('default')
    })
    // Valid diagram hit cache on Light return; only the un-cached broken block might retry or wait — ensure valid diagram came from cache without doubling render count
    expect(
      mermaidMockState.render.mock.calls
        .slice(callsAfterDark)
        .filter(([, src]) => !String(src).includes('SYNTAX_ERROR'))
    ).toHaveLength(0)

    // Switch to WYSIWYG: Mermaid NodeView renders both SVG and error isolation
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
    await waitFor(() => {
      const blocks = within(screen.getByTestId('document-editor')).getAllByTestId('wysiwyg-mermaid-block')
      expect(blocks).toHaveLength(2)
      expect(blocks[0].querySelector('svg')?.getAttribute('data-mermaid-theme')).toBe('default')
      expect(within(blocks[1]).getByRole('alert').textContent).toContain('SYNTAX_ERROR broken node')
    })

    // Return to Raw: lossless roundtrip preserves original markdown without dirty flag
    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(diagramDoc)
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
  })

  it('updates sidebar Outline ignoring code fences, toggles showHeadingNumbers cleanly with persistence, and scrolls to headings across modes', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const guideDoc = [
        '# Intro',
        '',
        '```bash',
        '# Ignored Comment',
        '```',
        '',
        '## Setup',
        '### Step One'
      ].join('\n')

      const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: true },
        {
          selectedFolder: 'C:\\wiki\\outline',
          workspaces: {
            'C:\\wiki\\outline': {
              'guide.md': guideDoc
            }
          }
        }
      )
      window.wikiApi = api

      const firstRender = render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('guide.md'))

      const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
      const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
      const items = within(within(outline).getByRole('list')).getAllByRole('listitem')
      expect(items).toHaveLength(3)
      expect(items[0].textContent).toContain('1.')
      expect(items[1].textContent).toContain('1.1.')
      expect(items[2].textContent).toContain('1.1.1.')
      expect(outline.textContent).not.toContain('Ignored Comment')

      // Click heading in Outline in Raw mode -> moves cursor to target heading line
      await user.click(within(items[1]).getByRole('button'))
      await waitFor(() => {
        expect(getRawEditorSelection(screen.getByTestId('document-editor')).start).toBe(
          guideDoc.indexOf('## Setup')
        )
      })

      // Switch to Preview mode and verify dynamic heading numbers + one-shot click-to-scroll
      const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
      await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
      const setupHeading = screen.getByRole('heading', { level: 2, name: 'Setup' })
      expect(setupHeading.textContent).toBe('1.1. Setup')

      scrollIntoViewMock.mockClear()
      await user.click(within(items[2]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // Toggle showHeadingNumbers off via Outline button -> hides numbers without dirtying buffer or re-scrolling
      await user.click(within(outline).getByRole('button', { name: '헤딩 번호 표시' }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('heading', { level: 2, name: 'Setup' }).textContent).toBe('Setup')
      expect(within(outline).queryByText('1.1.')).not.toBeInTheDocument()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(getFilesSnapshot().get('C:/wiki/outline/guide.md')).toBe(guideDoc)

      // Verify WYSIWYG mode reflects dynamic heading numbering toggle and one-shot click-to-scroll too
      await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
      scrollIntoViewMock.mockClear()
      const currentItems = within(within(outline).getByRole('list')).getAllByRole('listitem')
      await user.click(within(currentItems[1]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // Open SettingsPanel, verify checkbox reflects false, toggle back true without re-scrolling and verify persistence across restart
      await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      const settingsPanel = screen.getByLabelText('전역 설정 패널')
      const headingToggleCheckbox = within(settingsPanel).getByRole('checkbox', {
        name: /헤딩 자동 넘버링 표시/i
      }) as HTMLInputElement
      expect(headingToggleCheckbox.checked).toBe(false)

      await user.click(headingToggleCheckbox)
      expect(headingToggleCheckbox.checked).toBe(true)

      firstRender.unmount()
      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
      const reopenedCheckbox = within(screen.getByLabelText('전역 설정 패널')).getByRole(
        'checkbox',
        {
          name: /헤딩 자동 넘버링 표시/i
        }
      ) as HTMLInputElement
      expect(reopenedCheckbox.checked).toBe(true)
    } finally {
      restore()
    }
  })

  it('inserts TOC block and writes/strips heading numbers outside code fences with split-pane sync', async () => {
    const user = userEvent.setup()
    const initialDoc = [
      '# Title',
      '',
      '```python',
      '# 99. Code comment must stay unchanged',
      '```',
      '',
      '## First Section',
      '## Second Section'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: true },
      {
        selectedFolder: 'C:\\wiki\\actions',
        workspaces: {
          'C:\\wiki\\actions': {
            'manual.md': initialDoc,
            'other.md': '# Other'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(within(sidebar).getByText('manual.md'))
    await user.click(within(sidebar).getByText('other.md'))

    // Open horizontal split panes by duplicating manual.md and keep <= 2 editor DOM instances
    const primaryPane = screen.getByTestId('pane-primary')

    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: 'manual.md' }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')
    await user.click(within(primaryPane).getByRole('tab', { name: 'manual.md' }))
    await user.click(
      within(within(secondaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Preview' }
      )
    )
    expect(screen.getAllByTestId('document-editor')).toHaveLength(2)

    // Focus primary pane and run "본문 헤딩 번호 쓰기"
    await user.click(within(primaryPane).getByRole('tab', { name: 'manual.md' }))
    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })

    await user.click(within(outline).getByRole('button', { name: '본문 헤딩 번호 쓰기' }))
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toContain(
      '# 1. Title'
    )
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toContain(
      '## 1.1. First Section'
    )
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toContain(
      '# 99. Code comment must stay unchanged'
    )
    expect(within(primaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Verify Preview pane displays explicit heading without double numbering ("1.1. 1.1. First Section")
    expect(
      within(secondaryPane).getByRole('heading', { level: 2, name: 'First Section' }).textContent
    ).toBe('1.1. First Section')

    // Run "본문에 목차 삽입"
    await user.click(within(outline).getByRole('button', { name: '본문에 목차 삽입' }))
    const afterToc = getRawEditorText(within(primaryPane).getByTestId('document-editor'))
    expect(afterToc).toContain('<!-- toc -->')
    expect(afterToc).toContain('- [1.1. First Section](#11-first-section)')
    expect(afterToc).toContain('<!-- /toc -->')
    expect(
      within(secondaryPane).getByRole('link', { name: '1.1. First Section' })
    ).toHaveAttribute('href', '#11-first-section')

    // Run "본문 헤딩 번호 제거" -> strips headings outside code fence only
    await user.click(within(outline).getByRole('button', { name: '본문 헤딩 번호 제거' }))
    const afterStrip = getRawEditorText(within(primaryPane).getByTestId('document-editor'))
    expect(afterStrip).toContain('# Title')
    expect(afterStrip).toContain('## First Section')
    expect(afterStrip).not.toContain('## 1.1. First Section')
    expect(afterStrip).toContain('# 99. Code comment must stay unchanged')
  })

  it('inserts TOC block after H1 when running Outline insert TOC in WYSIWYG mode', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: false },
      {
        selectedFolder: 'C:\\wiki\\wysiwyg-toc',
        workspaces: {
          'C:\\wiki\\wysiwyg-toc': {
            'doc.md': ['# Heading', '', '## Details'].join('\n')
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('doc.md'))

    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: '위지윅'
      })
    )

    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
    await user.click(within(outline).getByRole('button', { name: '본문에 목차 삽입' }))

    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: 'Raw'
      })
    )
    const rawText = getRawEditorText(screen.getByTestId('document-editor'))
    expect(rawText).toContain('<!-- toc -->')
    expect(rawText).toContain('- [Heading](#heading)')
    expect(rawText).toContain('  - [Details](#details)')
    expect(rawText).toContain('<!-- /toc -->')
  })

  it('does not replay stale outlineScrollRequest after tab switch or global Ctrl+1/Ctrl+3 shortcuts', async () => {
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const user = userEvent.setup()
      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\scroll-once',
          workspaces: {
            'C:\\wiki\\scroll-once': {
              'alpha.md': ['# Alpha', '', '## Target Heading', '', 'Body'].join('\n'),
              'beta.md': ['# Beta', '', 'Other'].join('\n')
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const sidebar = screen.getByLabelText('워크스페이스 탐색기')
      await user.click(within(sidebar).getByText('alpha.md'))
      await user.click(within(sidebar).getByText('beta.md'))
      await user.click(screen.getByRole('tab', { name: 'alpha.md' }))

      await user.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Preview'
        })
      )

      const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
      const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
      await user.click(within(outline).getByRole('button', { name: /Target Heading/i }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      scrollIntoViewMock.mockClear()
      await user.click(screen.getByRole('tab', { name: 'beta.md' }))
      await user.click(screen.getByRole('tab', { name: 'alpha.md' }))
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      await user.click(within(outline).getByRole('button', { name: /Target Heading/i }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      scrollIntoViewMock.mockClear()
      fireEvent.keyDown(window, { key: '1', ctrlKey: true })
      expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')
      fireEvent.keyDown(window, { key: '3', ctrlKey: true })
      expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('renders Document Outline in expanded right sidebar (240px) to the right of PaneWorkspace instead of left sidebar', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const paneWorkspace = screen.getByTestId('pane-workspace')
    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })

    expect(
      leftSidebar.compareDocumentPosition(paneWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      paneWorkspace.compareDocumentPosition(rightSidebar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(
      within(leftSidebar).queryByRole('region', { name: '문서 목차 (Outline)' })
    ).not.toBeInTheDocument()

    expect(rightSidebar).toHaveStyle({ width: '240px' })
    const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
    expect(within(outline).getByText('Outline')).toBeInTheDocument()
    expect(within(outline).getByRole('button', { name: '문서 목차 접기' })).toBeInTheDocument()
    expect(within(outline).getByText('열린 문서 없음')).toBeInTheDocument()
  })

  it('keeps right sidebar mounted with empty-state messages when no document, non-markdown, or headingless document is active', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\outline-empty',
        workspaces: {
          'C:\\wiki\\outline-empty': {
            'notes.txt': 'Plain text file',
            'blank.md': 'Just paragraph text without headings',
            'guide.md': '# Guide Heading\n\n## Sub Heading'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    expect(within(rightSidebar).getByText('열린 문서 없음')).toBeInTheDocument()
    expect(
      within(rightSidebar).getByRole('button', { name: '본문에 목차 삽입' })
    ).toBeDisabled()

    await user.click(await within(explorer).findByText('notes.txt'))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBe(rightSidebar)
    expect(
      within(rightSidebar).getByText('마크다운 문서에서만 목차를 지원합니다.')
    ).toBeInTheDocument()
    expect(
      within(rightSidebar).getByRole('button', { name: '본문에 목차 삽입' })
    ).toBeDisabled()
    expect(
      within(rightSidebar).getByRole('button', { name: '본문 헤딩 번호 쓰기' })
    ).toBeDisabled()
    expect(
      within(rightSidebar).getByRole('button', { name: '본문 헤딩 번호 제거' })
    ).toBeDisabled()

    await user.click(within(explorer).getByText('blank.md'))
    expect(within(rightSidebar).getByText('표시할 헤딩이 없습니다.')).toBeInTheDocument()

    await user.click(within(explorer).getByText('guide.md'))
    const items = within(within(rightSidebar).getByRole('list')).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Guide Heading')

    await user.click(screen.getByRole('button', { name: 'guide.md 탭 닫기' }))
    await user.click(screen.getByRole('button', { name: 'blank.md 탭 닫기' }))
    await user.click(screen.getByRole('button', { name: 'notes.txt 탭 닫기' }))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBe(rightSidebar)
    expect(within(rightSidebar).getByText('열린 문서 없음')).toBeInTheDocument()
  })
})

describe('Settings UI and strict config.json schema without customCommands', () => {
  it('omits custom command management from Settings Panel and rejects customCommands in direct config.json edits', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\raw-config-strict',
        workspaces: {
          'C:\\wiki\\raw-config-strict': {
            'guide.md': '# Guide\n\n'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('guide.md'))

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const settingsPanel = screen.getByLabelText('전역 설정 패널')
    expect(
      within(settingsPanel).queryByRole('region', { name: '커스텀 명령어 관리' })
    ).not.toBeInTheDocument()
    expect(within(settingsPanel).queryByText('커스텀 명령어')).not.toBeInTheDocument()

    await user.click(within(settingsPanel).getByRole('button', { name: /설정 파일 직접 열기/i }))
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    const configEditor = await screen.findByTestId('document-editor')
    const beforeConfig = await api.config.get()

    const legacyJsonConfig = JSON.stringify(
      {
        ...beforeConfig,
        customCommands: []
      },
      null,
      2
    )
    setRawEditorText(configEditor, legacyJsonConfig)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unknown config key: "customCommands"'
    )
    expect(await api.config.get()).toEqual(beforeConfig)

    const validJsonConfig = JSON.stringify(
      {
        ...beforeConfig,
        theme: 'dark'
      },
      null,
      2
    )
    setRawEditorText(configEditor, validJsonConfig)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })
})

describe('Workspace Git sidebar integration & safe buffer/tree refresh', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('supports git init on non-git workspace, staging/committing, pull refreshing clean buffer & tree, dirty confirm, and conflict warning', async () => {
    const user = userEvent.setup()
    let isRepo = false
    let currentBranch = 'main'
    let staged: Array<{ path: string; status: 'A' | 'M' }> = []
    let unstaged: Array<{ path: string; status: 'M' }> = [{ path: 'guide.md', status: 'M' }]
    let currentStatus = () => ({
      ...createEmptyGitStatus(isRepo, 'C:/wiki'),
      branch: isRepo ? currentBranch : null,
      hasUpstream: isRepo,
      ahead: isRepo ? 1 : 0,
      behind: isRepo ? 1 : 0,
      staged: isRepo ? staged : [],
      unstaged: isRepo ? unstaged : [],
      untracked: []
    })

    let pullFailure: Error | null = null
    let pullMutation: (() => Promise<void>) | null = null
    let checkoutMutation: (() => Promise<void>) | null = null

    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => currentStatus()),
      init: vi.fn(async () => {
        isRepo = true
        return currentStatus()
      }),
      branches: vi.fn(async () => ({
        current: currentBranch,
        isDetached: false,
        branches: [
          { name: 'main', current: currentBranch === 'main', upstream: null },
          { name: 'docs-v2', current: currentBranch === 'docs-v2', upstream: null }
        ]
      })),
      stage: vi.fn(async (_ws, paths) => {
        for (const p of paths) {
          unstaged = unstaged.filter((item) => item.path !== p)
          staged = [...staged, { path: p, status: 'M' }]
        }
        return currentStatus()
      }),
      commit: vi.fn(async () => {
        staged = []
        return currentStatus()
      }),
      pull: vi.fn(async () => {
        if (pullFailure) throw pullFailure
        if (pullMutation) await pullMutation()
        unstaged = []
        return currentStatus()
      }),
      checkout: vi.fn(async (_ws, branchName) => {
        currentBranch = branchName
        if (checkoutMutation) await checkoutMutation()
        return currentStatus()
      })
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'guide.md': '# Initial Guide'
          }
        },
        git: gitMocks
      }
    )

    // Wire pull/checkout mutations directly onto the virtual workspace files
    pullMutation = async () => {
      await api.workspace.writeFile('C:/wiki/guide.md', '# Pulled From Remote')
      await api.workspace.createEntry('C:/wiki', 'pulled.md', 'file', '# Pulled File')
    }
    checkoutMutation = async () => {
      await api.workspace.writeFile('C:/wiki/guide.md', '# Docs V2 Branch')
    }

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, 'Git')
    const gitRegionInitial = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(
      within(gitRegionInitial).getByText(/워크스페이스를 먼저 열어주세요/)
    ).toBeInTheDocument()

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await within(explorer).findByText('guide.md')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(gitRegion).getByRole('button', { name: /Git 저장소 초기화/i })).toBeInTheDocument()
    await user.click(within(gitRegion).getByRole('button', { name: /Git 저장소 초기화/i }))

    expect(await within(gitRegion).findByLabelText('현재 브랜치 main')).toBeInTheDocument()
    await user.click(within(gitRegion).getByRole('button', { name: 'guide.md Stage' }))
    await user.type(within(gitRegion).getByLabelText('커밋 메시지'), 'feat: stage guide')
    await user.click(within(gitRegion).getByRole('button', { name: 'Commit' }))
    expect(gitMocks.commit).toHaveBeenCalledWith('C:/wiki', 'feat: stage guide')

    // Open guide.md cleanly in editor, then trigger Pull -> clean buffer & tree refresh automatically
    await clickActivityBarButton(user, '탐색기')
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('guide.md'))
    const editorEl = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editorEl)).toBe('# Initial Guide')

    await clickActivityBarButton(user, 'Git')
    const gitRegionAfterOpen = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegionAfterOpen).getByRole('button', { name: 'Pull' }))

    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Pulled From Remote')
    })
    await clickActivityBarButton(user, '탐색기')
    expect(
      await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('pulled.md')
    ).toBeInTheDocument()

    // Edit guide.md without saving -> Checkout prompts confirmation
    appendRawEditorText(screen.getByTestId('document-editor'), '\nUnsaved draft line')
    await clickActivityBarButton(user, 'Git')
    const gitRegionForBranch = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.selectOptions(within(gitRegionForBranch).getByLabelText('브랜치 선택'), 'docs-v2')
    await user.click(within(gitRegionForBranch).getByRole('button', { name: '브랜치 전환' }))

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(within(confirmDialog).getByText(/guide.md/)).toBeInTheDocument()

    // Canceling aborts checkout cleanly
    await user.click(within(confirmDialog).getByRole('button', { name: '취소' }))
    expect(gitMocks.checkout).not.toHaveBeenCalled()

    // Trigger checkout again and proceed without saving -> dirty edit is preserved & conflict warning appears
    await user.click(within(gitRegionForBranch).getByRole('button', { name: '브랜치 전환' }))
    const secondDialog = await screen.findByRole('alertdialog')
    await user.click(within(secondDialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(gitMocks.checkout).toHaveBeenCalledWith('C:/wiki', 'docs-v2')
    })
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('Unsaved draft line')
    expect(await within(gitRegionForBranch).findByRole('alert')).toHaveTextContent(
      /충돌할 수 있습니다 \(guide\.md\)/
    )

    // Dismiss Git error and trigger real Git error -> displayed safely inside Git panel
    await user.click(within(gitRegionForBranch).getByRole('button', { name: 'Git 오류 닫기' }))
    expect(within(gitRegionForBranch).queryByRole('alert')).not.toBeInTheDocument()

    // Save dirty edits via saving dialog path, then test Git pull failure
    pullFailure = new Error('원격 저장소 인증에 실패했습니다.')
    await user.click(within(gitRegionForBranch).getByRole('button', { name: 'Pull' }))
    const saveDialog = await screen.findByRole('alertdialog')
    await user.click(within(saveDialog).getByRole('button', { name: '저장 후 진행' }))

    expect(await within(gitRegionForBranch).findByRole('alert')).toHaveTextContent(
      '원격 저장소 인증에 실패했습니다.'
    )
  })

  it('closes deleted clean tabs and preserves deleted dirty tabs with warning after Sync', async () => {
    const user = userEvent.setup()
    const cleanStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki'),
      branch: 'main',
      hasUpstream: true
    }

    let syncMutation: (() => Promise<void>) | null = null
    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => cleanStatus),
      branches: vi.fn(async () => ({
        current: 'main',
        isDetached: false,
        branches: [{ name: 'main', current: true, upstream: 'origin/main' }]
      })),
      sync: vi.fn(async () => {
        if (syncMutation) await syncMutation()
        return { status: cleanStatus, pulled: true, pushed: true, summary: '동기화 완료' }
      })
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'obsolete.md': '# Obsolete',
            'keep-dirty.md': '# Local Original'
          }
        },
        git: gitMocks
      }
    )

    syncMutation = async () => {
      await api.workspace.deleteEntry('C:/wiki/obsolete.md')
      await api.workspace.deleteEntry('C:/wiki/keep-dirty.md')
    }

    window.wikiApi = api
    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    // Open both files: leave obsolete.md clean and make keep-dirty.md dirty
    await user.click(await within(explorer).findByText('obsolete.md'))
    expect(await screen.findByRole('tab', { name: 'obsolete.md' })).toBeInTheDocument()

    await user.click(within(explorer).getByText('keep-dirty.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), '\nImportant local edit')

    // Switch to Git view and click Sync -> proceed without saving -> obsolete.md clean tab closes, dirty keep-dirty.md stays open with warning
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: 'Sync' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'obsolete.md' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('tab', { name: /keep-dirty\.md/ })).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('Important local edit')
    expect(await within(gitRegion).findByRole('alert')).toHaveTextContent(
      /삭제되었으나 미저장 편집 내용이 남아 있습니다 \(keep-dirty\.md\)/
    )
  })

  it('supports fixed common branch/sync controls while Changes is collapsed, Changes/Graph accordion transitions, section resizer keyboard/double-click, and session-only preservation across view switches', async () => {
    const user = userEvent.setup()
    let currentBranch = 'main'
    const buildStatus = () => ({
      ...createEmptyGitStatus(true, 'C:/wiki/split-git'),
      branch: currentBranch,
      hasUpstream: true,
      staged: [{ path: 'staged.md', status: 'A' as const }],
      unstaged: [{ path: 'changed.md', status: 'M' as const }],
      untracked: [{ path: 'draft.md', status: '?' as const }]
    })

    const checkoutSpy = vi.fn(async (_ws: string, branchName: string) => {
      currentBranch = branchName
      return buildStatus()
    })
    const syncSpy = vi.fn(async () => ({
      status: buildStatus(),
      pulled: true,
      pushed: true,
      summary: '동기화 완료'
    }))

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-git',
        workspaces: {
          'C:/wiki/split-git': {
            'changed.md': '# Changed'
          }
        },
        git: {
          status: vi.fn(async () => buildStatus()),
          branches: vi.fn(async () => ({
            current: currentBranch,
            isDetached: false,
            branches: [
              { name: 'main', current: currentBranch === 'main', upstream: 'origin/main' },
              { name: 'docs-v2', current: currentBranch === 'docs-v2', upstream: null }
            ]
          })),
          checkout: checkoutSpy,
          sync: syncSpy
        }
      }
    )
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    const view = render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(gitRegion).queryByRole('button', { name: /Git.*main/i })).not.toBeInTheDocument()

    const changesToggle = within(gitRegion).getByRole('button', { name: /Changes/i })
    const graphToggle = within(gitRegion).getByRole('button', { name: /Graph/i })
    expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(changesToggle).toHaveTextContent('3')
    expect(graphToggle).toHaveAttribute('aria-expanded', 'true')

    const resizer = within(gitRegion).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    expect(resizer).toHaveAttribute('aria-orientation', 'horizontal')
    expect(resizer).toHaveAttribute('aria-valuemin', '20')
    expect(resizer).toHaveAttribute('aria-valuemax', '80')
    expect(resizer).toHaveAttribute('aria-valuenow', '50')

    // Collapse Changes -> separator hides, Graph fills height, branch switch & Sync in fixed common area still work
    await user.click(changesToggle)
    expect(changesToggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(gitRegion).queryByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).not.toBeInTheDocument()
    expect(within(gitRegion).queryByLabelText('커밋 메시지')).not.toBeInTheDocument()
    expect(within(gitRegion).getByRole('region', { name: 'Graph' })).toHaveStyle({
      flex: '1 1 0%'
    })

    await user.selectOptions(within(gitRegion).getByLabelText('브랜치 선택'), 'docs-v2')
    await user.click(within(gitRegion).getByRole('button', { name: '브랜치 전환' }))
    await waitFor(() => {
      expect(checkoutSpy).toHaveBeenCalledWith('C:/wiki/split-git', 'docs-v2')
      expect(within(gitRegion).getByLabelText('현재 브랜치 docs-v2')).toBeInTheDocument()
    })

    await user.click(within(gitRegion).getByRole('button', { name: 'Sync' }))
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalledTimes(1)
    })

    // Collapse Graph too -> both sections collapsed
    await user.click(graphToggle)
    expect(graphToggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(gitRegion).queryByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).not.toBeInTheDocument()

    // Re-expand both -> resizer returns
    await user.click(changesToggle)
    await user.click(graphToggle)
    const activeResizer = within(gitRegion).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    expect(activeResizer).toHaveAttribute('aria-valuenow', '50')

    // Keyboard resize & clamping [20, 80] + double-click restore 50%
    fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    expect(activeResizer).toHaveAttribute('aria-valuenow', '55')
    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    }
    expect(activeResizer).toHaveAttribute('aria-valuenow', '80')
    for (let i = 0; i < 15; i += 1) {
      fireEvent.keyDown(activeResizer, { key: 'ArrowUp' })
    }
    expect(activeResizer).toHaveAttribute('aria-valuenow', '20')

    fireEvent.doubleClick(activeResizer)
    expect(activeResizer).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    expect(activeResizer).toHaveAttribute('aria-valuenow', '60')

    // Collapse Graph, switch away to Explorer and back to Git -> collapsed state & 60% ratio preserved
    await user.click(graphToggle)
    await clickActivityBarButton(user, '탐색기')
    await clickActivityBarButton(user, 'Git')

    const reopenedGit = screen.getByRole('region', { name: 'Git 소스 제어' })
    const reopenedGraphToggle = within(reopenedGit).getByRole('button', { name: /Graph/i })
    expect(reopenedGraphToggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(reopenedGraphToggle)
    expect(
      within(reopenedGit).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).toHaveAttribute('aria-valuenow', '60')

    // Session-only: config.json untouched, remount resets to expanded 50%
    expect(configUpdateSpy).not.toHaveBeenCalled()
    view.unmount()

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const remountedGit = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(remountedGit).getByRole('button', { name: /Changes/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(remountedGit).getByRole('button', { name: /Graph/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(
      within(remountedGit).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).toHaveAttribute('aria-valuenow', '50')
  })

  it('shows unborn commit history empty message in Graph section when repository has no commits', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/unborn-repo',
        workspaces: {
          'C:/wiki/unborn-repo': {
            'README.md': '# Hello'
          }
        },
        git: {
          status: vi.fn(async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/unborn-repo'),
            branch: 'main',
            isUnborn: true
          })),
          branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
          log: vi.fn(async () => ({ commits: [], hasMore: false }))
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const graphRegion = screen.getByRole('region', { name: 'Graph' })
    expect(within(graphRegion).getByText('아직 커밋된 내역이 없습니다.')).toBeInTheDocument()
  })

  it('renders Graph commit lanes and badges, filters 전체/현재 브랜치 without collapsing, paginates with 더 보기, and refreshes on commit and workspace changes', async () => {
    const user = userEvent.setup()

    const makeCommit = (
      hash: string,
      parents: string[],
      subject: string,
      authorName: string,
      refs: GitGraphCommit['refs'] = []
    ): GitGraphCommit => ({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      subject,
      authorName,
      committedAt: '2026-11-15T06:30:00Z',
      refs
    })

    const allCommits: GitGraphCommit[] = [
      makeCommit(
        'aaaa111111111111111111111111111111111111',
        ['bbbb222222222222222222222222222222222222', 'cccc333333333333333333333333333333333333'],
        'Merge feature-x',
        'Alice',
        [
          { name: 'HEAD', kind: 'head', isCurrentHead: true },
          { name: 'main', kind: 'local-branch', isCurrentHead: true },
          { name: 'origin/main', kind: 'remote-branch' },
          { name: 'v1.0.0', kind: 'tag' }
        ]
      ),
      makeCommit(
        'cccc333333333333333333333333333333333333',
        ['bbbb222222222222222222222222222222222222'],
        'Side branch work',
        'Bob',
        [{ name: 'feature-x', kind: 'local-branch' }]
      )
    ]

    const currentPage1: GitGraphCommit[] = [
      makeCommit(
        'aaaa111111111111111111111111111111111111',
        ['bbbb222222222222222222222222222222222222'],
        'Merge feature-x',
        'Alice',
        [
          { name: 'HEAD', kind: 'head', isCurrentHead: true },
          { name: 'main', kind: 'local-branch', isCurrentHead: true }
        ]
      )
    ]

    const currentPage2: GitGraphCommit[] = [
      makeCommit(
        'bbbb222222222222222222222222222222222222',
        [],
        'Older mainline commit',
        'Carol'
      )
    ]

    const committedHead = makeCommit(
      'dddd444444444444444444444444444444444444',
      ['aaaa111111111111111111111111111111111111'],
      'Add sidebar graph test',
      'Alice',
      [
        { name: 'HEAD', kind: 'head', isCurrentHead: true },
        { name: 'main', kind: 'local-branch', isCurrentHead: true }
      ]
    )

    const externalCommit = makeCommit(
      'eeee555555555555555555555555555555555555',
      ['dddd444444444444444444444444444444444444'],
      'External CLI commit',
      'Dana',
      [
        { name: 'HEAD', kind: 'head', isCurrentHead: true },
        { name: 'main', kind: 'local-branch', isCurrentHead: true }
      ]
    )

    let hasCommitted = false
    let hasExternalCommit = false
    let delayNextAllScope = false
    let resolveDelayedAll!: (result: GitLogResult) => void

    const logSpy = vi.fn(
      (_ws: string, options?: { scope?: 'all' | 'current'; limit?: number; skip?: number }) => {
        if (options?.scope === 'current') {
          if (hasExternalCommit) {
            return Promise.resolve({ commits: [externalCommit, committedHead], hasMore: false })
          }
          if (hasCommitted) {
            return Promise.resolve({ commits: [committedHead, ...currentPage1], hasMore: false })
          }
          if ((options.skip ?? 0) > 0) {
            return Promise.resolve({ commits: currentPage2, hasMore: false })
          }
          return Promise.resolve({ commits: currentPage1, hasMore: true })
        }

        if (delayNextAllScope) {
          delayNextAllScope = false
          return new Promise<GitLogResult>((resolve) => {
            resolveDelayedAll = resolve
          })
        }

        return Promise.resolve({ commits: allCommits, hasMore: false })
      }
    )

    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/graph-app',
        workspaces: {
          'C:/wiki/graph-app': {
            'notes.md': '# Notes'
          }
        },
        git: {
          status: vi.fn(async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/graph-app'),
            branch: 'main',
            staged: hasCommitted ? [] : [{ path: 'notes.md', status: 'M' as GitFileStatusCode }]
          })),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [
              { name: 'main', current: true, upstream: 'origin/main' },
              { name: 'feature-x', current: false, upstream: null }
            ]
          })),
          commit: vi.fn(async () => {
            hasCommitted = true
            return {
              ...createEmptyGitStatus(true, 'C:/wiki/graph-app'),
              branch: 'main'
            }
          }),
          log: logSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const graphRegion = within(gitRegion).getByRole('region', { name: 'Graph' })
    const graphAccordionBtn = within(graphRegion).getByRole('button', { name: /Graph/i })

    await waitFor(() => {
      expect(within(graphRegion).getByText('Merge feature-x')).toBeInTheDocument()
    })
    expect(within(graphRegion).getByText('Side branch work')).toBeInTheDocument()
    expect(within(graphRegion).getByText('HEAD')).toHaveClass('is-head')
    expect(within(graphRegion).getByText('main')).toHaveClass('is-local-branch')
    expect(within(graphRegion).getByText('origin/main')).toHaveClass('is-remote-branch')
    expect(within(graphRegion).getByText('v1.0.0')).toHaveClass('is-tag')
    expect(graphRegion.querySelectorAll('svg.git-graph-svg').length).toBe(2)

    const items = within(within(graphRegion).getByRole('list', { name: '커밋 그래프' })).getAllByRole(
      'listitem'
    )
    expect(items[0].getAttribute('title')).toMatch(
      /^aaaa111 · Alice · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Merge feature-x$/
    )

    // Switch to 현재 브랜치 without toggling Graph accordion collapse
    const allBtn = within(graphRegion).getByRole('button', { name: '전체' })
    const currentBtn = within(graphRegion).getByRole('button', { name: '현재 브랜치' })
    expect(allBtn).toHaveAttribute('aria-pressed', 'true')

    await user.click(currentBtn)
    await waitFor(() => {
      expect(within(graphRegion).queryByText('Side branch work')).not.toBeInTheDocument()
    })
    expect(graphAccordionBtn).toHaveAttribute('aria-expanded', 'true')
    expect(currentBtn).toHaveAttribute('aria-pressed', 'true')

    // Click 더 보기 to paginate current branch commits
    await user.click(within(graphRegion).getByRole('button', { name: '더 보기' }))
    await waitFor(() => {
      expect(within(graphRegion).getByText('Older mainline commit')).toBeInTheDocument()
    })
    expect(logSpy).toHaveBeenCalledWith('C:/wiki/graph-app', {
      scope: 'current',
      limit: 100,
      skip: 1
    })

    // Trigger delayed 전체 request, then immediately toggle back to 현재 브랜치 -> stale response ignored
    delayNextAllScope = true
    await user.click(allBtn)
    await user.click(currentBtn)
    await waitFor(() => {
      expect(within(graphRegion).getByText('Merge feature-x')).toBeInTheDocument()
    })
    await act(async () => {
      resolveDelayedAll({
        commits: [makeCommit('stale99999999999999999999999999999999999', [], 'Stale commit', 'Ghost')],
        hasMore: false
      })
    })
    expect(within(graphRegion).queryByText('Stale commit')).not.toBeInTheDocument()

    // Commit refreshes Graph to latest page 1
    await user.type(within(gitRegion).getByLabelText('커밋 메시지'), 'Add sidebar graph test')
    await user.click(within(gitRegion).getByRole('button', { name: 'Commit' }))
    await waitFor(() => {
      expect(within(graphRegion).getByText('Add sidebar graph test')).toBeInTheDocument()
    })

    // Workspace change event also refreshes Graph automatically
    hasExternalCommit = true
    await act(async () => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki/graph-app',
        eventType: 'change',
        relativePath: 'notes.md'
      })
    })
    await waitFor(() => {
      expect(within(graphRegion).getByText('External CLI commit')).toBeInTheDocument()
    })
  })

  it('expands inline commit detail with files, switches/collapses commits, copies full hash, and clears on scope switch', async () => {
    const user = userEvent.setup()
    const firstHash = '1111111111111111111111111111111111111111'
    const emptyHash = '2222222222222222222222222222222222222222'

    const commitDetailSpy = vi.fn(async (_rootPath: string, commitHash: string) => {
      if (commitHash === firstHash) {
        return {
          hash: firstHash,
          shortHash: '1111111',
          parents: [emptyHash],
          subject: 'feat: graph detail commit',
          body: 'Detailed body line 1\nDetailed body line 2',
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          committedAt: '2026-11-15T10:00:00+09:00',
          files: [
            { status: 'A' as GitFileStatusCode, path: 'docs/added.md' },
            { status: 'M' as GitFileStatusCode, path: 'notes.md' },
            { status: 'R' as GitFileStatusCode, origPath: 'old.md', path: 'renamed.md' }
          ]
        }
      }

      return {
        hash: emptyHash,
        shortHash: '2222222',
        parents: [],
        subject: 'chore: empty root commit',
        body: '',
        authorName: 'Bob',
        authorEmail: 'bob@example.com',
        committedAt: '2026-11-14T10:00:00+09:00',
        files: []
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/graph-detail-app',
        workspaces: {
          'C:/wiki/graph-detail-app': {
            'notes.md': '# Notes'
          }
        },
        git: {
          status: vi.fn(async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/graph-detail-app'),
            branch: 'main'
          })),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [{ name: 'main', current: true, upstream: null }]
          })),
          log: vi.fn(async (_rootPath: string, options?: { scope?: 'all' | 'current' }) => ({
            commits:
              options?.scope === 'current'
                ? [
                    {
                      hash: emptyHash,
                      shortHash: '2222222',
                      parents: [],
                      subject: 'chore: empty root commit',
                      authorName: 'Bob',
                      committedAt: '2026-11-14T10:00:00+09:00',
                      refs: [{ name: 'HEAD', kind: 'head' as const }]
                    }
                  ]
                : [
                    {
                      hash: firstHash,
                      shortHash: '1111111',
                      parents: [emptyHash],
                      subject: 'feat: graph detail commit',
                      authorName: 'Alice',
                      committedAt: '2026-11-15T10:00:00+09:00',
                      refs: [{ name: 'main', kind: 'local-branch' as const }]
                    },
                    {
                      hash: emptyHash,
                      shortHash: '2222222',
                      parents: [],
                      subject: 'chore: empty root commit',
                      authorName: 'Bob',
                      committedAt: '2026-11-14T10:00:00+09:00',
                      refs: [{ name: 'HEAD', kind: 'head' as const }]
                    }
                  ],
            hasMore: false
          })),
          commitDetail: commitDetailSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const graphRegion = within(gitRegion).getByRole('region', { name: 'Graph' })

    const firstRowBtn = await within(graphRegion).findByRole('button', {
      name: /feat: graph detail commit/
    })
    expect(firstRowBtn).toHaveAttribute('aria-expanded', 'false')

    // Click commit row -> expands inline detail directly inside the same commit item
    await user.click(firstRowBtn)
    expect(commitDetailSpy).toHaveBeenCalledWith('C:/wiki/graph-detail-app', firstHash)

    const firstDetailRegion = await within(graphRegion).findByRole('region', {
      name: '1111111 커밋 상세'
    })
    expect(firstRowBtn).toHaveAttribute('aria-expanded', 'true')
    const firstListItem = firstRowBtn.closest('li')
    expect(firstListItem).not.toBeNull()
    expect(firstListItem?.contains(firstDetailRegion)).toBe(true)

    expect(firstDetailRegion).toHaveTextContent('Detailed body line 1')
    expect(firstDetailRegion).toHaveTextContent('Detailed body line 2')
    expect(firstDetailRegion).toHaveTextContent('alice@example.com')
    expect(firstDetailRegion).toHaveTextContent('docs/added.md')
    expect(firstDetailRegion).toHaveTextContent('notes.md')
    expect(firstDetailRegion).toHaveTextContent('old.md → renamed.md')

    // Copy full commit hash
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    try {
      await user.click(within(firstDetailRegion).getByRole('button', { name: '해시 복사' }))
      expect(writeTextSpy).toHaveBeenCalledWith(firstHash)
    } finally {
      writeTextSpy.mockRestore()
    }

    // Click another commit -> replaces inline detail and collapses previous row
    const secondRowBtn = within(graphRegion).getByRole('button', {
      name: /chore: empty root commit/
    })
    await user.click(secondRowBtn)
    expect(commitDetailSpy).toHaveBeenCalledWith('C:/wiki/graph-detail-app', emptyHash)

    const emptyDetailRegion = await within(graphRegion).findByRole('region', {
      name: '2222222 커밋 상세'
    })
    expect(firstRowBtn).toHaveAttribute('aria-expanded', 'false')
    expect(secondRowBtn).toHaveAttribute('aria-expanded', 'true')
    expect(emptyDetailRegion).toHaveTextContent('변경된 파일이 없습니다.')
    expect(within(graphRegion).queryByRole('region', { name: '1111111 커밋 상세' })).toBeNull()

    // Scope toggle clears expanded detail cleanly
    await user.click(within(graphRegion).getByRole('button', { name: '현재 브랜치' }))
    await waitFor(() => {
      expect(within(graphRegion).queryByRole('region', { name: '2222222 커밋 상세' })).toBeNull()
    })

    // Re-expand and click same commit row again to collapse
    const currentRowBtn = await within(graphRegion).findByRole('button', {
      name: /chore: empty root commit/
    })
    await user.click(currentRowBtn)
    await within(graphRegion).findByRole('region', { name: '2222222 커밋 상세' })
    await user.click(currentRowBtn)
    expect(currentRowBtn).toHaveAttribute('aria-expanded', 'false')
    expect(within(graphRegion).queryByRole('region', { name: '2222222 커밋 상세' })).toBeNull()
  })
})

describe('Renderer error logging & UI breadcrumbs', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('captures global window error and unhandledrejection with stack traces and handles failing log.write safely', async () => {
    const entries: RendererLogPayload[] = []
    const writeSpy = vi.fn(async (payload: RendererLogPayload) => {
      entries.push(payload)
    })

    const { api } = createInMemoryWikiApi({}, { log: { write: writeSpy } })
    window.wikiApi = api

    const view = render(<App />)
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const syncError = new Error('Uncaught UI failure')
    const rejectedError = new Error('Unhandled async rejection')

    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', {
          message: syncError.message,
          error: syncError,
          filename: 'App.tsx',
          lineno: 12,
          colno: 4
        })
      )
      const rejectionEvent = Object.assign(new Event('unhandledrejection'), {
        reason: rejectedError
      })
      window.dispatchEvent(rejectionEvent)
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      level: 'error',
      category: 'error',
      message: 'Unhandled error in renderer',
      data: {
        filename: 'App.tsx',
        lineno: 12,
        colno: 4
      },
      error: {
        name: 'Error',
        message: 'Uncaught UI failure'
      }
    })
    expect(entries[0].error?.stack).toContain('Uncaught UI failure')

    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'error',
      message: 'Unhandled promise rejection in renderer',
      error: {
        name: 'Error',
        message: 'Unhandled async rejection'
      }
    })
    expect(entries[1].error?.stack).toContain('Unhandled async rejection')

    // Failing log.write must never throw or recurse
    view.unmount()
    const failingWrite = vi.fn(async () => {
      throw new Error('Log IPC broken')
    })
    const { api: failingLogApi } = createInMemoryWikiApi({}, { log: { write: failingWrite } })
    window.wikiApi = failingLogApi

    render(<App />)
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', {
          message: 'Secondary error',
          error: new Error('Secondary error')
        })
      )
    })
    expect(failingWrite).toHaveBeenCalledTimes(1)
  })

  it('logs error entries when error banner or Git panel displays errors without leaking note content', async () => {
    const user = userEvent.setup()
    const entries: RendererLogPayload[] = []
    const writeSpy = vi.fn(async (payload: RendererLogPayload) => {
      entries.push(payload)
    })

    const repoStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki/errlog'),
      branch: 'main',
      hasUpstream: true
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/errlog',
        workspaces: {
          'C:/wiki/errlog': {
            'note.md': 'PRIVATE_DOC_BODY'
          }
        },
        git: {
          status: vi.fn(async () => repoStatus),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [{ name: 'main', current: true, upstream: 'origin/main' }]
          })),
          push: vi.fn(async () => {
            throw new Error('Remote auth failed')
          })
        },
        log: { write: writeSpy }
      }
    )
    api.workspace.writeFile = async () => {
      throw new Error('Disk full')
    }
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('note.md'))

    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, '\nNEW_SECRET_TEXT')
    await user.click(screen.getByRole('button', { name: '저장' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: 'Push' }))
    expect(await within(gitRegion).findByRole('alert')).toHaveTextContent('Remote auth failed')

    const errorEntries = entries.filter((entry) => entry.level === 'error')
    expect(errorEntries.some((entry) => entry.error?.message === 'Disk full')).toBe(true)
    expect(
      errorEntries.some(
        (entry) => entry.category === 'git' && entry.error?.message === 'Remote auth failed'
      )
    ).toBe(true)

    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('PRIVATE_DOC_BODY')
    expect(serialized).not.toContain('NEW_SECRET_TEXT')
  })

  it('records chronological ui breadcrumbs for workspace, tabs, editor modes, and split modes without logging document content or typing', async () => {
    const user = userEvent.setup()
    const entries: RendererLogPayload[] = []
    const writeSpy = vi.fn(async (payload: RendererLogPayload) => {
      entries.push(payload)
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/breadcrumbs',
        workspaces: {
          'C:/wiki/breadcrumbs': {
            'alpha.md': 'SECRET_ALPHA_TEXT',
            'beta.md': 'SECRET_BETA_TEXT'
          }
        },
        log: { write: writeSpy }
      }
    )
    window.wikiApi = api

    render(<App />)

    // 1. Open workspace
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    // 2. Open two tabs and type in editor (typing must NOT generate logs or leak body)
    await user.click(await within(explorer).findByText('alpha.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), '\nTYPED_SECRET_CONTENT')
    await user.click(within(explorer).getByText('beta.md'))

    // 3. Switch back to alpha.md tab in primary tab bar
    const primaryPane = screen.getByTestId('pane-primary')
    await user.click(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))

    // 4. Switch editor modes: Raw -> 위지윅 -> Preview -> Raw
    const modeGroup = within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))

    // 5. Drag beta.md onto horizontal split drop zone, then drag onto vertical drop zone
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /beta\.md/ }))
    fireEvent.drop(await screen.findByTestId('split-drop-zone-horizontal'))
    const secondaryPane = screen.getByTestId('pane-secondary')
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /beta\.md/ }))
    fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))

    // 6. Duplicate alpha.md to secondary pane
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )

    // 7. Close secondary tabs to collapse back to single mode
    await user.click(within(secondaryPane).getByRole('button', { name: 'beta.md 탭 닫기' }))
    await user.click(within(secondaryPane).getByRole('button', { name: 'alpha.md 탭 닫기' }))

    const uiEntries = entries.filter((entry) => entry.category === 'ui' && entry.level === 'info')
    expect(uiEntries.map((entry) => entry.message)).toEqual([
      'Workspace opened',
      'Tab opened',
      'Tab opened',
      'Tab switched',
      'Editor mode changed',
      'Editor mode changed',
      'Editor mode changed',
      'Tab moved',
      'Split mode changed',
      'Split mode changed',
      'Tab duplicated',
      'Tab closed',
      'Tab closed',
      'Split mode changed'
    ])

    expect(uiEntries[4].data).toMatchObject({ from: 'raw', to: 'wysiwyg' })
    expect(uiEntries[5].data).toMatchObject({ from: 'wysiwyg', to: 'preview' })
    expect(uiEntries[6].data).toMatchObject({ from: 'preview', to: 'raw' })
    expect(uiEntries[8].data).toMatchObject({ from: 'single', to: 'horizontal' })
    expect(uiEntries[9].data).toMatchObject({ from: 'horizontal', to: 'vertical' })
    expect(uiEntries[13].data).toMatchObject({ from: 'vertical', to: 'single' })

    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('SECRET_ALPHA_TEXT')
    expect(serialized).not.toContain('SECRET_BETA_TEXT')
    expect(serialized).not.toContain('TYPED_SECRET_CONTENT')
  })

  it('logs Tab switched when clicking an already-selected tab in the inactive split pane and logs Tab switched instead of Tab duplicated for an already-open tab', async () => {
    const user = userEvent.setup()
    const entries: RendererLogPayload[] = []
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-switch',
        workspaces: {
          'C:/wiki/split-switch': {
            'alpha.md': '# Alpha',
            'beta.md': '# Beta'
          }
        },
        log: {
          write: (payload) => {
            entries.push(payload)
            return Promise.resolve()
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('alpha.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )

    const baselineCount = entries.length

    // Clicking the already-selected tab in the inactive primary pane must record 'Tab switched'
    await user.click(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))

    // Duplicating alpha.md again when secondary already holds it must switch focus rather than log 'Tab duplicated'
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )

    const recentUi = entries
      .slice(baselineCount)
      .filter((entry) => entry.category === 'ui' && entry.level === 'info')
    expect(recentUi.map((entry) => ({ message: entry.message, paneId: entry.data?.paneId }))).toEqual([
      { message: 'Tab switched', paneId: 'primary' },
      { message: 'Tab switched', paneId: 'secondary' }
    ])
  })

  it('automatically opens the last opened workspace (recentWorkspaces[0]) on startup', async () => {
    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/gamma', 'C:/wiki/alpha']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('gamma.md')).toBeInTheDocument()
    expect(within(explorer).getByText('gamma')).toHaveAttribute('title', 'C:/wiki/gamma')
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    expect(within(activityBar).getByRole('button', { name: '탐색기' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('starts silently in empty workspace state and removes invalid path from recentWorkspaces when startup workspace open fails', async () => {
    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/missing', 'C:/wiki/gamma']
      },
      {
        workspaces: {
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    const workspaceView = await screen.findByRole('region', { name: '워크스페이스 뷰' })
    expect(within(workspaceView).getByText('열린 워크스페이스 없음')).toBeInTheDocument()
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    expect(within(activityBar).getByRole('button', { name: '워크스페이스' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await waitFor(async () => {
      const cfg = await api.config.get()
      expect(cfg.recentWorkspaces).toEqual(['C:/wiki/gamma'])
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: /gamma/i })).toBeInTheDocument()
    expect(within(workspaceView).queryByRole('button', { name: /missing/i })).not.toBeInTheDocument()
  })
})

describe('Activity bar and left sidebar view switching', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('renders activity bar with 탐색기, Git, and 워크스페이스 buttons, defaults to Workspace view without open workspace, and switches single views on click', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const paneWorkspace = screen.getByTestId('pane-workspace')

    expect(
      activityBar.compareDocumentPosition(leftSidebar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      leftSidebar.compareDocumentPosition(paneWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    const explorerBtn = within(activityBar).getByRole('button', { name: '탐색기' })
    const gitBtn = within(activityBar).getByRole('button', { name: 'Git' })
    const workspaceBtn = within(activityBar).getByRole('button', { name: '워크스페이스' })

    expect(explorerBtn).toHaveAttribute('title', '탐색기')
    expect(gitBtn).toHaveAttribute('title', 'Git')
    expect(workspaceBtn).toHaveAttribute('title', '워크스페이스')
    expect(explorerBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(gitBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(workspaceBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    // Initial view without an open workspace is Workspace View
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'true')
    expect(workspaceBtn).toHaveClass('is-active')
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'false')
    expect(explorerBtn).not.toHaveClass('is-active')
    expect(gitBtn).toHaveAttribute('aria-pressed', 'false')
    expect(gitBtn).not.toHaveClass('is-active')
    expect(within(leftSidebar).getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()
    expect(
      within(leftSidebar).queryByRole('region', { name: '워크스페이스 탐색기' })
    ).not.toBeInTheDocument()
    expect(
      within(leftSidebar).queryByRole('region', { name: 'Git 소스 제어' })
    ).not.toBeInTheDocument()

    // Click Explorer -> switches left sidebar to Explorer view only
    await user.click(explorerBtn)
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'true')
    expect(explorerBtn).toHaveClass('is-active')
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'false')
    expect(workspaceBtn).not.toHaveClass('is-active')
    expect(within(leftSidebar).getByRole('region', { name: '워크스페이스 탐색기' })).toBeInTheDocument()
    expect(
      within(leftSidebar).queryByRole('region', { name: '워크스페이스 뷰' })
    ).not.toBeInTheDocument()

    // Click Git -> switches left sidebar to Git panel only
    await user.click(gitBtn)
    expect(gitBtn).toHaveAttribute('aria-pressed', 'true')
    expect(gitBtn).toHaveClass('is-active')
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'false')
    expect(explorerBtn).not.toHaveClass('is-active')
    expect(within(leftSidebar).getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()
    expect(
      within(leftSidebar).queryByRole('region', { name: '워크스페이스 탐색기' })
    ).not.toBeInTheDocument()

    // Click Workspace -> switches back to Workspace View only
    await user.click(workspaceBtn)
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'true')
    expect(workspaceBtn).toHaveClass('is-active')
    expect(gitBtn).toHaveAttribute('aria-pressed', 'false')
    expect(within(leftSidebar).getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()
    expect(
      within(leftSidebar).queryByRole('region', { name: 'Git 소스 제어' })
    ).not.toBeInTheDocument()
  })

  it('collapses and expands left sidebar via activity bar transitions for all three views and keeps sidebar state session-only', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    const view = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    const explorerBtn = within(activityBar).getByRole('button', { name: '탐색기' })
    const gitBtn = within(activityBar).getByRole('button', { name: 'Git' })
    const workspaceBtn = within(activityBar).getByRole('button', { name: '워크스페이스' })

    // Collapse from Workspace by clicking active Workspace button
    await user.click(workspaceBtn)
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '워크스페이스 뷰' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '액티비티 바' })).toBeInTheDocument()
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'false')
    expect(workspaceBtn).not.toHaveClass('is-active')
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'false')
    expect(gitBtn).toHaveAttribute('aria-pressed', 'false')

    // Click Git while collapsed -> expands straight into Git view
    await user.click(gitBtn)
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()
    expect(gitBtn).toHaveAttribute('aria-pressed', 'true')
    expect(gitBtn).toHaveClass('is-active')
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'false')

    // Collapse from Git by clicking active Git button
    await user.click(gitBtn)
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    expect(gitBtn).toHaveAttribute('aria-pressed', 'false')

    // Click Explorer while collapsed -> expands straight into Explorer view
    await user.click(explorerBtn)
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '워크스페이스 탐색기' })).toBeInTheDocument()
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'true')

    // Collapse from Explorer, then expand straight into Workspace view
    await user.click(explorerBtn)
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    await user.click(workspaceBtn)
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'true')

    // Collapse again and verify nothing is persisted to config.json; remount starts expanded on Workspace
    await user.click(workspaceBtn)
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    expect(configUpdateSpy).not.toHaveBeenCalled()

    view.unmount()
    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })
    const restartedBar = screen.getByRole('navigation', { name: '액티비티 바' })
    expect(within(restartedBar).getByRole('button', { name: '워크스페이스' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()
  })

  it('preserves folder tree expansion and Git state across view switches and collapse/expand, and keeps context menu and branch selector functional', async () => {
    const user = userEvent.setup()
    let staged: Array<{ path: string; status: 'M' }> = []
    let unstaged: Array<{ path: string; status: 'M' }> = [{ path: 'notes.md', status: 'M' }]
    const buildStatus = () => ({
      ...createEmptyGitStatus(true, 'C:/wiki/preserve'),
      branch: 'main',
      hasUpstream: true,
      staged,
      unstaged,
      untracked: []
    })
    const gitStatusSpy = vi.fn(async () => buildStatus())
    const gitStageSpy = vi.fn(async (_ws: string, paths: string[]) => {
      for (const p of paths) {
        unstaged = unstaged.filter((item) => item.path !== p)
        staged = [...staged, { path: p, status: 'M' }]
      }
      return buildStatus()
    })

    const { api, emitMenuCommand, readDirCalls } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\preserve',
        workspaces: {
          'C:\\wiki\\preserve': {
            'docs/intro.md': '# Intro',
            'notes.md': '# Notes'
          }
        },
        git: {
          status: gitStatusSpy,
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [
              { name: 'main', current: true, upstream: 'origin/main' },
              { name: 'feature/sidebar', current: false, upstream: null }
            ]
          })),
          stage: gitStageSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('docs'))
    expect(await within(explorer).findByText('intro.md')).toBeInTheDocument()
    expect(readDirCalls).toEqual(['C:/wiki/preserve', 'C:/wiki/preserve/docs'])

    // Context menu opens and executes on tree entry inside Explorer view
    fireEvent.contextMenu(within(explorer).getByText('intro.md'))
    const contextMenu = await screen.findByRole('menu')
    await user.click(within(contextMenu).getByRole('menuitem', { name: '열기' }))
    expect(await screen.findByRole('tab', { name: 'intro.md' })).toBeInTheDocument()

    // Switch to Git view -> Git state & branch dropdown work, stage notes.md
    const statusCallsBeforeSwitch = gitStatusSpy.mock.calls.length
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const branchSelect = within(gitRegion).getByLabelText('브랜치 선택') as HTMLSelectElement
    expect(Array.from(branchSelect.options).map((o) => o.value)).toEqual([
      'main',
      'feature/sidebar'
    ])
    await user.selectOptions(branchSelect, 'feature/sidebar')
    expect(branchSelect.value).toBe('feature/sidebar')

    await user.click(within(gitRegion).getByRole('button', { name: 'notes.md Stage' }))
    expect(await within(gitRegion).findByRole('button', { name: 'notes.md Unstage' })).toBeInTheDocument()

    // Switch back to Explorer, collapse, and reopen Explorer -> expansion & selection preserved without re-reading dir
    await clickActivityBarButton(user, '탐색기')
    const reopenedExplorer = screen.getByLabelText('워크스페이스 탐색기')
    expect(within(reopenedExplorer).getByText('intro.md')).toBeInTheDocument()
    expect(within(reopenedExplorer).getByRole('treeitem', { name: 'docs' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(reopenedExplorer).getByRole('treeitem', { name: 'intro.md' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await clickActivityBarButton(user, '탐색기')
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    await clickActivityBarButton(user, '탐색기')
    expect(
      within(screen.getByLabelText('워크스페이스 탐색기')).getByText('intro.md')
    ).toBeInTheDocument()
    expect(readDirCalls).toEqual(['C:/wiki/preserve', 'C:/wiki/preserve/docs'])

    // Switch back to Git -> staged state preserved without extra git.status fetch
    await clickActivityBarButton(user, 'Git')
    const reopenedGit = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(reopenedGit).getByRole('button', { name: 'notes.md Unstage' })).toBeInTheDocument()
    expect(gitStatusSpy).toHaveBeenCalledTimes(statusCallsBeforeSwitch)
  })

  it('displays Git badge for staged + unstaged + untracked changes (>0, capped at 99+) and hides it when 0, non-repo, or no workspace', async () => {
    const user = userEvent.setup()
    const makeFiles = (prefix: string, count: number, status: GitFileStatusCode = 'M') =>
      Array.from({ length: count }, (_, idx) => ({
        path: `${prefix}-${idx}.md`,
        status
      }))

    let currentStatusByRoot: Record<string, ReturnType<typeof createEmptyGitStatus>> = {
      'C:/wiki/repo': {
        ...createEmptyGitStatus(true, 'C:/wiki/repo'),
        branch: 'main',
        staged: makeFiles('staged', 1),
        unstaged: makeFiles('unstaged', 2),
        untracked: makeFiles('new', 1, '?')
      },
      'C:/wiki/plain': {
        ...createEmptyGitStatus(false, 'C:/wiki/plain'),
        // Even if arrays were non-empty, isRepo=false must never render a badge
        unstaged: makeFiles('ignored', 2)
      }
    }

    let nextSelectedFolder = 'C:/wiki/repo'
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      {},
      {
        workspaces: {
          'C:\\wiki\\repo': { 'a.md': '# A' },
          'C:\\wiki\\plain': { 'b.md': '# B' }
        },
        git: {
          status: vi.fn(async (rootPath) => {
            const norm = rootPath.replace(/\\/g, '/')
            return currentStatusByRoot[norm] ?? createEmptyGitStatus(false, rootPath)
          })
        }
      }
    )
    api.workspace.selectFolder = async () => nextSelectedFolder
    window.wikiApi = api

    render(<App />)

    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    const gitBtn = within(activityBar).getByRole('button', { name: 'Git' })

    // 1. No workspace open -> no badge
    expect(gitBtn).toHaveTextContent('')

    // 2. Open Git repo with 1 + 2 + 1 = 4 changes (while Explorer view is still active)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(await within(gitBtn).findByText('4')).toBeInTheDocument()

    // Badge remains visible when sidebar is collapsed
    await clickActivityBarButton(user, '탐색기')
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    expect(within(gitBtn).getByText('4')).toBeInTheDocument()

    const triggerRepoChange = (): void => {
      act(() => {
        emitWorkspaceChange({ rootPath: 'C:/wiki/repo', eventType: 'change', relativePath: 'a.md' })
      })
    }

    // 3. Exactly 99 changes -> '99'
    currentStatusByRoot['C:/wiki/repo'] = {
      ...createEmptyGitStatus(true, 'C:/wiki/repo'),
      branch: 'main',
      staged: makeFiles('s', 33),
      unstaged: makeFiles('u', 33),
      untracked: makeFiles('n', 33, '?')
    }
    triggerRepoChange()
    expect(await within(gitBtn).findByText('99')).toBeInTheDocument()

    // 4. Over 99 changes (100) -> '99+'
    currentStatusByRoot['C:/wiki/repo'] = {
      ...createEmptyGitStatus(true, 'C:/wiki/repo'),
      branch: 'main',
      staged: makeFiles('s', 34),
      unstaged: makeFiles('u', 33),
      untracked: makeFiles('n', 33, '?')
    }
    triggerRepoChange()
    expect(await within(gitBtn).findByText('99+')).toBeInTheDocument()

    // 5. Clean repo (0 changes) -> badge disappears
    currentStatusByRoot['C:/wiki/repo'] = {
      ...createEmptyGitStatus(true, 'C:/wiki/repo'),
      branch: 'main'
    }
    triggerRepoChange()
    await waitFor(() => {
      expect(gitBtn).toHaveTextContent('')
    })

    // Restore changes, then switch to non-git workspace -> badge disappears
    currentStatusByRoot['C:/wiki/repo'] = {
      ...createEmptyGitStatus(true, 'C:/wiki/repo'),
      branch: 'main',
      unstaged: makeFiles('u', 3)
    }
    triggerRepoChange()
    expect(await within(gitBtn).findByText('3')).toBeInTheDocument()

    nextSelectedFolder = 'C:/wiki/plain'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await waitFor(() => {
      expect(gitBtn).toHaveTextContent('')
    })
  })
})

describe('Left sidebar resizing', () => {
  const initialInnerWidth = window.innerWidth

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: initialInnerWidth
    })
  })

  it('renders vertical separator with bounds and resizes left sidebar via ArrowLeft/ArrowRight clamped to [180, 512]', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const resizer = screen.getByRole('separator', { name: '왼쪽 사이드바 너비 조절' })

    expect(leftSidebar).toHaveStyle({ width: '260px' })
    expect(resizer).toHaveAttribute('aria-orientation', 'vertical')
    expect(resizer).toHaveAttribute('aria-valuemin', '180')
    expect(resizer).toHaveAttribute('aria-valuemax', '512')
    expect(resizer).toHaveAttribute('aria-valuenow', '260')
    expect(resizer).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(resizer, { key: 'ArrowRight' })
    const widened = Number(resizer.getAttribute('aria-valuenow'))
    expect(widened).toBeGreaterThan(260)
    expect(leftSidebar).toHaveStyle({ width: `${widened}px` })

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    expect(resizer).toHaveAttribute('aria-valuenow', '260')
    expect(leftSidebar).toHaveStyle({ width: '260px' })

    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '180')
    expect(leftSidebar).toHaveStyle({ width: '180px' })
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()

    for (let i = 0; i < 25; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowRight' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '512')
    expect(leftSidebar).toHaveStyle({ width: '512px' })
  })

  it('resizes via pointer/mouse drag with col-resize cursor & selection lock, stays expanded at min 180px, and resets to 260px on double-click', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const resizer = screen.getByRole('separator', { name: '왼쪽 사이드바 너비 조절' })

    // Pointer drag: start at 260px, drag +100px -> 360px, then drag far left -> clamped at 180px without collapsing
    fireEvent.pointerDown(resizer, { button: 0, clientX: 306 })
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')
    expect(document.body).toHaveClass('is-resizing-sidebar')

    fireEvent.pointerMove(window, { clientX: 406 })
    expect(leftSidebar).toHaveStyle({ width: '360px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '360')

    fireEvent.pointerMove(window, { clientX: 20 })
    expect(leftSidebar).toHaveStyle({ width: '180px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '180')
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()

    fireEvent.pointerUp(window)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(document.body).not.toHaveClass('is-resizing-sidebar')

    // Moving after pointerUp does not resize
    fireEvent.pointerMove(window, { clientX: 350 })
    expect(leftSidebar).toHaveStyle({ width: '180px' })

    // Double-click restores default 260px
    fireEvent.doubleClick(resizer)
    expect(leftSidebar).toHaveStyle({ width: '260px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '260')

    // Mouse drag fallback (compatible with mouse-only events)
    fireEvent.mouseDown(resizer, { button: 0, clientX: 306 })
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.mouseMove(window, { clientX: 386 })
    expect(leftSidebar).toHaveStyle({ width: '340px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '340')
    fireEvent.mouseUp(window)
    expect(document.body.style.cursor).toBe('')

    fireEvent.doubleClick(resizer)
    expect(leftSidebar).toHaveStyle({ width: '260px' })
  })

  it('clamps width when window shrinks below current width, hides resizer when collapsed, preserves width across views/expand, and resets on remount without persisting config', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:/wiki/resize-ws',
        workspaces: {
          'C:/wiki/resize-ws': { 'note.md': '# Note' }
        }
      }
    )
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    const view = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const resizer = screen.getByRole('separator', { name: '왼쪽 사이드바 너비 조절' })

    // Drag to 460px
    fireEvent.pointerDown(resizer, { button: 0, clientX: 306 })
    fireEvent.pointerMove(window, { clientX: 506 })
    fireEvent.pointerUp(window)
    expect(leftSidebar).toHaveStyle({ width: '460px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '460')

    // Shrink window width to 640px -> max becomes 320px, current width clamps to 320px
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 640
    })
    fireEvent(window, new Event('resize'))

    expect(resizer).toHaveAttribute('aria-valuemax', '320')
    expect(resizer).toHaveAttribute('aria-valuenow', '320')
    expect(leftSidebar).toHaveStyle({ width: '320px' })

    // Stepping down from clamped 320px decreases immediately (no stale 460px state)
    fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    const narrowed = Number(resizer.getAttribute('aria-valuenow'))
    expect(narrowed).toBeLessThan(320)
    expect(leftSidebar).toHaveStyle({ width: `${narrowed}px` })

    // View switch preserves resized width
    await clickActivityBarButton(user, '탐색기')
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toHaveStyle({
      width: `${narrowed}px`
    })

    // Collapsing hides both sidebar and resizer
    await clickActivityBarButton(user, '탐색기')
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('separator', { name: '왼쪽 사이드바 너비 조절' })
    ).not.toBeInTheDocument()

    // Re-expanding restores resizer and previous session width
    await clickActivityBarButton(user, 'Git')
    const reopenedSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const reopenedResizer = screen.getByRole('separator', { name: '왼쪽 사이드바 너비 조절' })
    expect(reopenedSidebar).toHaveStyle({ width: `${narrowed}px` })
    expect(reopenedResizer).toHaveAttribute('aria-valuenow', String(narrowed))

    // Opening workspace preserves width across automatic switch to explorer
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toHaveStyle({
      width: `${narrowed}px`
    })

    // Session-only: config.json untouched, remount resets to 260px
    expect(configUpdateSpy).not.toHaveBeenCalled()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: initialInnerWidth
    })
    view.unmount()
    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toHaveStyle({
      width: '260px'
    })
    expect(screen.getByRole('separator', { name: '왼쪽 사이드바 너비 조절' })).toHaveAttribute(
      'aria-valuenow',
      '260'
    )
  })
})

describe('Right sidebar collapse, expand, and resizing', () => {
  it('collapses right sidebar via header button to thin vertical expand tab and re-expands cleanly', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:/wiki/right-collapse',
        workspaces: {
          'C:/wiki/right-collapse': {
            'first.md': '# First Heading\n\n## Sub Heading',
            'second.md': '# Second Heading'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('first.md'))

    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    expect(rightSidebar).toHaveStyle({ width: '240px' })
    expect(screen.queryByRole('button', { name: '문서 목차 펼치기' })).not.toBeInTheDocument()

    const collapseBtn = within(rightSidebar).getByRole('button', { name: '문서 목차 접기' })
    expect(collapseBtn).toHaveAttribute('title', '문서 목차 접기')
    expect(collapseBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    await user.click(collapseBtn)

    expect(screen.queryByRole('complementary', { name: '우측 사이드바' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '문서 목차 (Outline)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: '우측 사이드바 너비 조절' })).not.toBeInTheDocument()

    const expandTab = screen.getByRole('button', { name: '문서 목차 펼치기' })
    expect(expandTab).toHaveAttribute('title', '문서 목차 펼치기')
    expect(expandTab.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    // Switching files while collapsed keeps right sidebar collapsed
    await user.click(within(explorer).getByText('second.md'))
    expect(screen.queryByRole('complementary', { name: '우측 사이드바' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '문서 목차 펼치기' })).toBeInTheDocument()

    // Re-expand via vertical tab restores right sidebar and reflects active document
    await user.click(screen.getByRole('button', { name: '문서 목차 펼치기' }))
    expect(screen.queryByRole('button', { name: '문서 목차 펼치기' })).not.toBeInTheDocument()
    const reopenedSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    expect(reopenedSidebar).toHaveStyle({ width: '240px' })
    expect(within(reopenedSidebar).getByText('Second Heading')).toBeInTheDocument()
  })

  it('renders vertical separator with bounds [180, 500] and resizes right sidebar via ArrowLeft/ArrowRight and double-click', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const paneWorkspace = screen.getByTestId('pane-workspace')
    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const resizer = screen.getByRole('separator', { name: '우측 사이드바 너비 조절' })

    expect(
      paneWorkspace.compareDocumentPosition(resizer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      resizer.compareDocumentPosition(rightSidebar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(rightSidebar).toHaveStyle({ width: '240px' })
    expect(resizer).toHaveAttribute('aria-orientation', 'vertical')
    expect(resizer).toHaveAttribute('aria-valuemin', '180')
    expect(resizer).toHaveAttribute('aria-valuemax', '500')
    expect(resizer).toHaveAttribute('aria-valuenow', '240')
    expect(resizer).toHaveAttribute('tabindex', '0')

    // ArrowLeft widens the right sidebar (left boundary moves left)
    fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    const widened = Number(resizer.getAttribute('aria-valuenow'))
    expect(widened).toBeGreaterThan(240)
    expect(rightSidebar).toHaveStyle({ width: `${widened}px` })

    // ArrowRight narrows it back
    fireEvent.keyDown(resizer, { key: 'ArrowRight' })
    expect(resizer).toHaveAttribute('aria-valuenow', '240')
    expect(rightSidebar).toHaveStyle({ width: '240px' })

    // Repeated ArrowRight clamps at minimum 180px without collapsing
    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowRight' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '180')
    expect(rightSidebar).toHaveStyle({ width: '180px' })
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBeInTheDocument()

    // Repeated ArrowLeft clamps at maximum 500px
    for (let i = 0; i < 20; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '500')
    expect(rightSidebar).toHaveStyle({ width: '500px' })

    // Double-click restores default 240px
    fireEvent.doubleClick(resizer)
    expect(resizer).toHaveAttribute('aria-valuenow', '240')
    expect(rightSidebar).toHaveStyle({ width: '240px' })
  })

  it('resizes right sidebar via pointer drag, preserves width across collapse/expand, and resets session-only on remount', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    const view = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const resizer = screen.getByRole('separator', { name: '우측 사이드바 너비 조절' })

    // Pointer drag left widens, right narrows, clamped to [180, 500]
    fireEvent.pointerDown(resizer, { button: 0, clientX: 784 })
    expect(document.body).toHaveClass('is-resizing-sidebar')
    fireEvent.pointerMove(window, { clientX: 684 })
    expect(rightSidebar).toHaveStyle({ width: '340px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '340')

    fireEvent.pointerMove(window, { clientX: 900 })
    expect(rightSidebar).toHaveStyle({ width: '180px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '180')

    fireEvent.pointerMove(window, { clientX: 704 })
    expect(rightSidebar).toHaveStyle({ width: '320px' })
    expect(resizer).toHaveAttribute('aria-valuenow', '320')

    fireEvent.pointerUp(window)
    expect(document.body).not.toHaveClass('is-resizing-sidebar')

    // Collapse hides resizer and sidebar, expand restores previous 320px width
    await user.click(within(rightSidebar).getByRole('button', { name: '문서 목차 접기' }))
    expect(screen.queryByRole('separator', { name: '우측 사이드바 너비 조절' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '문서 목차 펼치기' }))
    const reopenedSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const reopenedResizer = screen.getByRole('separator', { name: '우측 사이드바 너비 조절' })
    expect(reopenedSidebar).toHaveStyle({ width: '320px' })
    expect(reopenedResizer).toHaveAttribute('aria-valuenow', '320')

    // Session-only: config.json untouched, remount resets to expanded 240px
    expect(configUpdateSpy).not.toHaveBeenCalled()
    view.unmount()
    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toHaveStyle({
      width: '240px'
    })
    expect(screen.getByRole('separator', { name: '우측 사이드바 너비 조절' })).toHaveAttribute(
      'aria-valuenow',
      '240'
    )
  })
})

describe('Settings Panel centered modal', () => {
  it('opens as a centered modal dialog outside main layout, toggles with toggle-settings, and closes via 닫기 button', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    // Open via toggle-settings menu command
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')

    const dialog = screen.getByRole('dialog', { name: '전역 설정 패널' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('전역 설정 패널')).toBe(dialog)

    // Modal is rendered outside <main> layout so it does not consume workspace/sidebar width
    const main = screen.getByRole('main')
    expect(within(main).queryByLabelText('전역 설정 패널')).not.toBeInTheDocument()
    expect(within(main).getAllByRole('complementary')).toHaveLength(2)

    // Clicking inside the dialog does not close it
    await user.click(within(dialog).getByRole('heading', { name: '전역 설정' }))
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    // Clicking 닫기 closes the modal
    await user.click(within(dialog).getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    // toggle-settings toggles open and closed again
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
  })

  it('closes Settings Panel on backdrop click and Esc key without closing on inner clicks', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    // Backdrop click closes modal, inner dialog click does not
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const dialog = screen.getByRole('dialog', { name: '전역 설정 패널' })
    await user.click(dialog)
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    const backdrop = dialog.parentElement!
    await user.click(backdrop)
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    // Esc via user keyboard closes modal
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    // Esc dispatched on window closes modal too
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
  })

  it('disables editor save and mode-switch shortcuts while Settings Panel is open', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\modal-shortcuts',
        workspaces: {
          'C:\\wiki\\modal-shortcuts': {
            'note.md': '# Note'
          }
        }
      }
    )
    const writeSpy = vi.spyOn(api.workspace, 'writeFile')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('note.md'))

    const editor = await screen.findByTestId('document-editor')
    setRawEditorText(editor, '# Updated')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const dialog = screen.getByRole('dialog', { name: '전역 설정 패널' })

    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(dialog, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor, { key: '2', ctrlKey: true })
    fireEvent.keyDown(window, { key: '3', ctrlKey: true })

    expect(writeSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()
    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    expect(within(modeGroup).getByRole('button', { name: 'Raw' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Closing modal re-enables editor shortcuts
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
  })

  it('closes Settings Panel when opening config.json directly and renders ConfirmDialog above Settings Panel', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\modal-layer',
        workspaces: {
          'C:\\wiki\\modal-layer': {
            'dirty.md': '# Dirty'
          },
          'C:\\wiki\\modal-next': {
            'next.md': '# Next'
          }
        }
      }
    )
    let nextFolder = 'C:\\wiki\\modal-layer'
    api.workspace.selectFolder = async () => nextFolder
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('dirty.md'))

    const editor = await screen.findByTestId('document-editor')
    setRawEditorText(editor, '# Dirty edited')

    // Open Settings modal, then trigger ConfirmDialog while settings modal is open
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const settingsDialog = screen.getByRole('dialog', { name: '전역 설정 패널' })

    nextFolder = 'C:\\wiki\\modal-next'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(settingsDialog).toBeInTheDocument()
    expect(
      settingsDialog.compareDocumentPosition(confirmDialog) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // Esc while ConfirmDialog is on top must not dismiss Settings modal underneath
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    // Dismiss ConfirmDialog via 취소 -> Settings modal remains open and interactive
    await user.click(within(confirmDialog).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    // Clicking 설정 파일 직접 열기 opens config.json and closes the Settings modal
    await user.click(within(settingsDialog).getByRole('button', { name: /설정 파일 직접 열기/i }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
    })
    const configEditor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(configEditor)).toContain('"theme": "light"')
  })
})

describe('Git Diff viewer tab and Changes section integration', () => {
  it('opens read-only diff tabs on Changes clicks, toggles inline/side-by-side, ignores +/- buttons, and opens editable files', async () => {
    const user = userEvent.setup()
    let revision = 1
    const diffSpy = vi.fn(async (_workspacePath: string, request: GitDiffRequest) => ({
      path: request.path,
      ...(request.origPath ? { origPath: request.origPath } : {}),
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: request.path !== 'deleted.md',
      rawPatch:
        request.path === 'deleted.md'
          ? ['diff --git a/deleted.md b/deleted.md', '@@ -1 +0,0 @@', '-gone'].join('\n')
          : [
              `diff --git a/${request.path} b/${request.path}`,
              `--- a/${request.path}`,
              `+++ b/${request.path}`,
              '@@ -1 +1 @@',
              `-old ${request.path} r${revision}`,
              `+new ${request.path} r${revision}`
            ].join('\n')
    }))
    const stageSpy = vi.fn(async (workspacePath: string) => ({
      ...createEmptyGitStatus(true, workspacePath),
      branch: 'main',
      staged: [{ path: 'guide.md', status: 'M' as const }],
      unstaged: [{ path: 'deleted.md', status: 'D' as const }]
    }))

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        version: 1,
        theme: 'light',
        autoSave: false,
        autoSaveDelayMs: 1000,
        showHeadingNumbers: true,
        recentWorkspaces: [],
        favoriteWorkspaces: []
      },
      {
        workspaces: {
          'C:/wiki/diff-app': {
            'guide.md': '# Guide\n## Sub\nUpdated body',
            'notes.md': '# Notes'
          }
        },
        selectedFolder: 'C:/wiki/diff-app',
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            staged: [{ path: 'guide.md', status: 'M' }],
            unstaged: [{ path: 'deleted.md', status: 'D' }],
            untracked: [{ path: 'notes.md', status: '?' }]
          }),
          stage: stageSpy,
          diff: diffSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(screen.getByRole('button', { name: 'Git' }))

    const gitPanel = await screen.findByLabelText('Git 소스 제어')

    // 1. Clicking + Stage button must NOT open a diff tab
    await user.click(await within(gitPanel).findByRole('button', { name: 'notes.md Stage' }))
    expect(stageSpy).toHaveBeenCalledWith('C:/wiki/diff-app', ['notes.md'])
    expect(screen.queryByRole('tab')).toBeNull()

    // 2. Clicking staged file opens Diff tab defaulting to side-by-side
    const stagedList = within(gitPanel).getByText('스테이지됨 (1)').closest('.git-section') as HTMLElement
    await user.click(within(stagedList).getByText('guide.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(1)
    expect(within(primaryPane).getByRole('tab', { name: /guide\.md/ })).toBeInTheDocument()
    expect(within(primaryPane).getByText('Staged')).toBeInTheDocument()
    expect(within(primaryPane).getByTestId('diff-side-by-side')).toBeInTheDocument()
    expect(within(primaryPane).getByText('old guide.md r1')).toBeInTheDocument()

    // Switch to inline view
    await user.click(within(primaryPane).getByRole('button', { name: '인라인' }))
    expect(within(primaryPane).getByTestId('diff-inline')).toBeInTheDocument()

    // 3. Clicking another file in Changes reuses the existing Diff tab in primary pane
    const changesList = within(gitPanel).getByText('변경 사항 (1)').closest('.git-section') as HTMLElement
    await user.click(within(changesList).getByText('deleted.md'))

    await waitFor(() => {
      expect(within(primaryPane).getByText('Working Tree')).toBeInTheDocument()
    })
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(1)
    expect(within(primaryPane).getByRole('tab', { name: /deleted\.md/ })).toBeInTheDocument()
    expect(within(primaryPane).getByRole('button', { name: '파일 열기' })).toBeDisabled()

    // 4. Switch back to guide.md and click 파일 열기 to open editable workspace tab
    revision = 2
    await user.click(within(stagedList).getByText('guide.md'))
    const openFileBtn = await within(primaryPane).findByRole('button', { name: '파일 열기' })
    await waitFor(() => expect(openFileBtn).toBeEnabled())
    await user.click(openFileBtn)

    await waitFor(() => {
      expect(within(primaryPane).getAllByRole('tab')).toHaveLength(2)
    })
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    expect(getRawEditorText(docEditor)).toContain('Updated body')
  })

  it('preserves split diff tabs, excludes diffs from autoSave/dirty/shortcuts/outline, refreshes on Git changes, and clears on workspace switch', async () => {
    const user = userEvent.setup()
    let patchCounter = 1
    let currentStaged: Array<{ path: string; status: 'M' | 'A' }> = [{ path: 'doc.md', status: 'M' }]
    let currentUnstaged: Array<{ path: string; status: 'M' | 'D' }> = [{ path: 'other.md', status: 'M' }]
    const writeFileSpy = vi.fn(async () => {})
    const diffSpy = vi.fn(async (_workspacePath: string, request: GitDiffRequest) => ({
      path: request.path,
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch:
        currentStaged.length === 0 && request.kind === 'staged'
          ? ''
          : [
              `diff --git a/${request.path} b/${request.path}`,
              `--- a/${request.path}`,
              `+++ b/${request.path}`,
              '@@ -1 +1 @@',
              `-before v${patchCounter}`,
              `+after v${patchCounter}`
            ].join('\n')
    }))

    const folders = {
      selected: 'C:/wiki/diff-one'
    }
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      {
        version: 1,
        theme: 'light',
        autoSave: true,
        autoSaveDelayMs: 60,
        showHeadingNumbers: true,
        recentWorkspaces: [],
        favoriteWorkspaces: []
      },
      {
        workspaces: {
          'C:/wiki/diff-one': {
            'doc.md': '# Heading\nbody',
            'other.md': '# Other'
          },
          'C:/wiki/diff-two': {
            'two.md': '# Two'
          }
        },
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            staged: currentStaged,
            unstaged: currentUnstaged
          }),
          stage: async (workspacePath) => {
            patchCounter += 1
            return {
              ...createEmptyGitStatus(true, workspacePath),
              branch: 'main',
              staged: currentStaged,
              unstaged: currentUnstaged
            }
          },
          commit: async (workspacePath) => {
            currentStaged = []
            patchCounter += 1
            return {
              ...createEmptyGitStatus(true, workspacePath),
              branch: 'main',
              staged: [],
              unstaged: currentUnstaged
            }
          },
          diff: diffSpy
        }
      }
    )
    api.workspace.selectFolder = async () => folders.selected
    api.workspace.writeFile = writeFileSpy
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Open a regular document tab and config.json first so secondary pane move is enabled
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('doc.md'))
    await screen.findByTestId('document-editor')

    await user.click(screen.getByRole('button', { name: 'Git' }))
    const gitPanel = await screen.findByLabelText('Git 소스 제어')

    // Open Staged diff for doc.md in primary pane -> move it to secondary pane
    const stagedList = within(gitPanel).getByText('스테이지됨 (1)').closest('.git-section') as HTMLElement
    await user.click(within(stagedList).getByText('doc.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    await within(primaryPane).findByText('after v1')

    // Document Outline must exclude active Diff tab even when target is .md
    const outlinePanel = screen.getByLabelText('문서 목차 (Outline)')
    expect(within(outlinePanel).getByText('마크다운 문서에서만 목차를 지원합니다.')).toBeInTheDocument()

    // Ctrl+S and Ctrl+Shift+M must NOT save or change editor mode on Diff tab
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'M', ctrlKey: true, shiftKey: true })
    expect(writeFileSpy).not.toHaveBeenCalled()

    // Move Diff tab to secondary pane via tab context menu
    const diffTabInPrimary = within(primaryPane).getByRole('tab', { name: /Diff\s*doc\.md/ })
    fireEvent.contextMenu(diffTabInPrimary)
    await user.click(await screen.findByRole('menuitem', { name: '분할 영역으로 이동' }))

    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*doc\.md/ })).toBeInTheDocument()

    // Focus primary pane and open another Diff tab -> secondary Diff tab stays preserved
    fireEvent.mouseDown(primaryPane)
    const changesList = within(gitPanel).getByText('변경 사항 (1)').closest('.git-section') as HTMLElement
    await user.click(within(changesList).getByText('other.md'))
    await within(primaryPane).findByText('after v1')
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*doc\.md/ })).toBeInTheDocument()

    // Wait longer than autoSaveDelayMs (60ms) -> Diff tab never triggers writeFile
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(writeFileSpy).not.toHaveBeenCalled()

    // Saving a regular document tab refreshes Git status -> open Diff tab auto-refreshes (after v2)
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc.md' }))
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    patchCounter = 2
    appendRawEditorText(docEditor, ' updated')
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(writeFileSpy).toHaveBeenCalled()
    })
    await user.click(within(primaryPane).getByRole('tab', { name: /Diff\s*other\.md/ }))
    await waitFor(() => {
      expect(within(primaryPane).getByText('after v2')).toBeInTheDocument()
    })

    // Stage action refreshes Git status -> open Diff tab auto-refreshes (after v3)
    await user.click(within(gitPanel).getByRole('button', { name: 'other.md Stage' }))
    await waitFor(() => {
      expect(within(primaryPane).getByText('after v3')).toBeInTheDocument()
    })

    // Commit -> triggers Git refresh -> open Diff tabs auto-refresh (staged doc.md empties, unstaged other.md gets v4)
    await user.type(within(gitPanel).getByLabelText('커밋 메시지'), 'commit staged')
    await user.click(within(gitPanel).getByRole('button', { name: 'Commit' }))

    await waitFor(() => {
      expect(within(primaryPane).getByText('after v4')).toBeInTheDocument()
      expect(within(secondaryPane).getByText('표시할 텍스트 변경 사항이 없습니다.')).toBeInTheDocument()
    })

    // External FS change event triggers Git refresh -> open unstaged Diff tab refreshes automatically
    patchCounter = 5
    act(() => {
      emitWorkspaceChange({ rootPath: 'C:/wiki/diff-one', eventType: 'change', relativePath: 'other.md' })
    })
    await waitFor(() => {
      expect(within(primaryPane).getByText('after v5')).toBeInTheDocument()
    })

    // Closing Diff tab never shows unsaved alertdialog
    await user.click(within(primaryPane).getByRole('button', { name: 'other.md 탭 닫기' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    // Switching workspace closes remaining Diff tab automatically
    folders.selected = 'C:/wiki/diff-two'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Diff\s*doc\.md/ })).not.toBeInTheDocument()
    })
  })
})

describe('Git Graph commit file diff integration', () => {
  it('opens read-only commit Diff tabs from Graph commit files, reuses active pane tabs while preserving split pane, toggles diff view mode, and gates 파일 열기 by workspace existence', async () => {
    const user = userEvent.setup()
    const commitHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    const shortHash = 'a1b2c3d'
    const buildDiffResponse = (
      request: GitDiffRequest,
      rawPatch: string,
      existsInWorkspace = true
    ) => ({
      path: request.path,
      ...(request.origPath ? { origPath: request.origPath } : {}),
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace,
      rawPatch
    })

    const diffSpy = vi.fn(async (_workspacePath: string, request: GitDiffRequest) => {
      if (request.kind === 'commit' && request.path === 'docs/removed-old.md') {
        return buildDiffResponse(
          request,
          [
            'diff --git a/docs/removed-old.md b/docs/removed-old.md',
            '--- a/docs/removed-old.md',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-removed historical line'
          ].join('\n'),
          false
        )
      }
      if (request.kind === 'commit' && request.path === 'docs/renamed.md') {
        return buildDiffResponse(
          request,
          [
            'diff --git a/docs/legacy.md b/docs/renamed.md',
            'similarity index 90%',
            'rename from docs/legacy.md',
            'rename to docs/renamed.md',
            '@@ -1 +1 @@',
            '-legacy title',
            '+renamed title'
          ].join('\n')
        )
      }
      const prefix = request.kind === 'commit' ? 'commit' : 'working'
      return buildDiffResponse(
        request,
        [
          `diff --git a/${request.path} b/${request.path}`,
          `--- a/${request.path}`,
          `+++ b/${request.path}`,
          '@@ -1 +1 @@',
          `-${prefix} before`,
          `+${prefix} after`
        ].join('\n')
      )
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        version: 1,
        theme: 'light',
        autoSave: false,
        autoSaveDelayMs: 1000,
        showHeadingNumbers: true,
        recentWorkspaces: [],
        favoriteWorkspaces: []
      },
      {
        workspaces: {
          'C:/wiki/graph-diff-app': {
            'docs/guide.md': '# Guide Current\nLatest workspace text',
            'docs/renamed.md': '# Renamed Current',
            'notes.md': '# Notes'
          }
        },
        selectedFolder: 'C:/wiki/graph-diff-app',
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            unstaged: [{ path: 'notes.md', status: 'M' }]
          }),
          log: async () => ({
            commits: [
              {
                hash: commitHash,
                shortHash,
                parents: [],
                subject: 'feat: commit with changed files',
                authorName: 'Alice',
                committedAt: '2026-11-15T10:00:00+09:00',
                refs: [{ name: 'main', kind: 'local-branch' }]
              }
            ],
            hasMore: false
          }),
          commitDetail: async () => ({
            hash: commitHash,
            shortHash,
            parents: [],
            subject: 'feat: commit with changed files',
            body: 'Commit body context',
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            committedAt: '2026-11-15T10:00:00+09:00',
            files: [
              { status: 'M', path: 'docs/guide.md' },
              { status: 'D', path: 'docs/removed-old.md' },
              { status: 'R', origPath: 'docs/legacy.md', path: 'docs/renamed.md' }
            ]
          }),
          diff: diffSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Open a regular document tab first so moving a Diff tab to secondary pane is enabled
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('notes.md'))
    await screen.findByTestId('document-editor')

    await user.click(screen.getByRole('button', { name: 'Git' }))

    const gitPanel = await screen.findByLabelText('Git 소스 제어')
    const graphRegion = within(gitPanel).getByRole('region', { name: 'Graph' })

    // 1. Expand commit in Graph section and click an existing changed file
    await user.click(within(graphRegion).getByRole('button', { name: /feat: commit with changed files/ }))
    const detailRegion = await within(graphRegion).findByRole('region', {
      name: `${shortHash} 커밋 상세`
    })

    await user.click(within(detailRegion).getByRole('button', { name: /docs\/guide\.md/ }))
    expect(diffSpy).toHaveBeenCalledWith('C:/wiki/graph-diff-app', {
      kind: 'commit',
      commitHash,
      shortHash,
      path: 'docs/guide.md',
      status: 'M'
    })

    const primaryPane = screen.getByTestId('pane-primary')
    const guideCommitTab = await within(primaryPane).findByRole('tab', {
      name: /Diff\s*guide\.md \(a1b2c3d\)/
    })
    expect(guideCommitTab).toHaveAttribute('title', 'docs/guide.md · Commit a1b2c3d')
    expect(within(primaryPane).getByText(`Commit ${shortHash}`)).toBeInTheDocument()
    expect(within(primaryPane).getByTestId('diff-side-by-side')).toBeInTheDocument()
    expect(within(primaryPane).getByText('commit after')).toBeInTheDocument()

    // Toggle Side-by-Side -> Inline on commit Diff tab
    await user.click(within(primaryPane).getByRole('button', { name: '인라인' }))
    expect(within(primaryPane).getByTestId('diff-inline')).toBeInTheDocument()

    const openFileBtn = within(primaryPane).getByRole('button', { name: '파일 열기' })
    expect(openFileBtn).toBeEnabled()

    // 2. Click historically deleted file in the same commit -> replaces active Diff tab and disables 파일 열기
    await user.click(within(detailRegion).getByRole('button', { name: /docs\/removed-old\.md/ }))
    await waitFor(() => {
      expect(within(primaryPane).getByText('removed historical line')).toBeInTheDocument()
    })
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(2)
    expect(
      within(primaryPane).getByRole('tab', { name: /Diff\s*removed-old\.md \(a1b2c3d\)/ })
    ).toBeInTheDocument()
    expect(within(primaryPane).getByRole('button', { name: '파일 열기' })).toBeDisabled()

    // 3. Click renamed commit file -> passes origPath and replaces active Diff tab
    await user.click(
      within(detailRegion).getByRole('button', { name: /docs\/legacy\.md → docs\/renamed\.md/ })
    )
    expect(diffSpy).toHaveBeenLastCalledWith('C:/wiki/graph-diff-app', {
      kind: 'commit',
      commitHash,
      shortHash,
      path: 'docs/renamed.md',
      origPath: 'docs/legacy.md',
      status: 'R'
    })
    await waitFor(() => {
      expect(within(primaryPane).getByText('renamed title')).toBeInTheDocument()
    })

    // 4. Open Working Tree Diff tab from Changes -> replaces commit Diff tab in active pane
    const changesList = within(gitPanel).getByText('변경 사항 (1)').closest('.git-section') as HTMLElement
    await user.click(within(changesList).getByText('notes.md'))
    await waitFor(() => {
      expect(within(primaryPane).getByText('working after')).toBeInTheDocument()
    })
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(2)

    // Move Working Tree Diff tab to secondary pane, focus primary pane, and open commit Diff tab in primary
    const workingTab = within(primaryPane).getByRole('tab', { name: /Diff\s*notes\.md/ })
    fireEvent.contextMenu(workingTab)
    await user.click(await screen.findByRole('menuitem', { name: '분할 영역으로 이동' }))

    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*notes\.md/ })).toBeInTheDocument()

    fireEvent.mouseDown(primaryPane)
    await user.click(within(detailRegion).getByRole('button', { name: /docs\/guide\.md/ }))
    await within(primaryPane).findByText('commit after')
    expect(
      within(primaryPane).getByRole('tab', { name: /Diff\s*guide\.md \(a1b2c3d\)/ })
    ).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*notes\.md/ })).toBeInTheDocument()

    // 5. Click 파일 열기 from commit Diff tab -> opens editable workspace document, close Diff tab cleanly
    await user.click(within(primaryPane).getByRole('button', { name: '파일 열기' }))
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    expect(getRawEditorText(docEditor)).toContain('Latest workspace text')

    await user.click(within(primaryPane).getByRole('button', { name: 'guide.md (a1b2c3d) 탭 닫기' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

function mountThemeStylesAndRoot(): { rootEl: HTMLDivElement; cleanup: () => void } {
  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-test-theme', 'true')
  styleEl.textContent = themeCss
  document.head.appendChild(styleEl)

  const rootEl = document.createElement('div')
  rootEl.id = 'root'
  document.body.appendChild(rootEl)

  return {
    rootEl,
    cleanup: () => {
      rootEl.remove()
      styleEl.remove()
    }
  }
}

function isZeroCssLength(value: string): boolean {
  return value === '0px' || value === '0'
}

function assertSidebarPanelIsolation(
  panel: HTMLElement,
  header: HTMLElement,
  scrollBody: HTMLElement
): void {
  expect(isZeroCssLength(getComputedStyle(panel).minHeight)).toBe(true)
  expect(getComputedStyle(panel).overflow).toBe('hidden')
  expect(getComputedStyle(header).flexShrink).toBe('0')
  expect(isZeroCssLength(getComputedStyle(scrollBody).minHeight)).toBe(true)
  expect(getComputedStyle(scrollBody).overflowY).toBe('auto')
}

describe('App shell viewport scroll isolation and left sidebar overflow contracts', () => {
  it('enforces viewport overflow isolation, min-height: 0 flex chain, and non-shrinking headers/toolbars across Raw, 위지윅, Preview, and single/horizontal/vertical split modes', async () => {
    const user = userEvent.setup()
    const longMarkdown = Array.from({ length: 40 }, (_, idx) => `## Section ${idx + 1}\n\nParagraph ${idx + 1}`).join('\n\n')
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\scroll-layout',
        workspaces: {
          'C:\\wiki\\scroll-layout': {
            'long-a.md': longMarkdown,
            'long-b.md': longMarkdown
          }
        }
      }
    )
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('long-a.md'))

      // Root document, #root, app shell, and main layout lock to viewport without whole-page scroll
      const mainEl = screen.getByRole('main')
      const appShell = mainEl.parentElement as HTMLElement
      for (const el of [document.documentElement, document.body, rootEl, appShell]) {
        expect(getComputedStyle(el).overflow).toBe('hidden')
      }
      expect(isZeroCssLength(getComputedStyle(appShell).minHeight)).toBe(true)

      const mainStyle = getComputedStyle(mainEl)
      expect(mainStyle.display).toBe('flex')
      expect(isZeroCssLength(mainStyle.minHeight)).toBe(true)
      expect(isZeroCssLength(mainStyle.minWidth)).toBe(true)
      expect(mainStyle.overflow).toBe('hidden')

      // Activity bar, left sidebar, right sidebar, and Document Outline scroll isolation
      expect(getComputedStyle(screen.getByRole('navigation', { name: '액티비티 바' })).flexShrink).toBe('0')

      for (const sidebar of [
        screen.getByRole('complementary', { name: '왼쪽 사이드바' }),
        screen.getByRole('complementary', { name: '우측 사이드바' })
      ]) {
        const sidebarStyle = getComputedStyle(sidebar)
        expect(sidebarStyle.flexShrink).toBe('0')
        expect(isZeroCssLength(sidebarStyle.minHeight)).toBe(true)
        expect(sidebarStyle.overflow).toBe('hidden')
      }

      const outlineRegion = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineHeader = outlineRegion.firstElementChild as HTMLElement
      const outlineActions = within(outlineRegion)
        .getByRole('button', { name: '본문에 목차 삽입' })
        .parentElement as HTMLElement
      const outlineListContainer = within(outlineRegion).getByRole('list').parentElement as HTMLElement
      assertSidebarPanelIsolation(outlineRegion, outlineHeader, outlineListContainer)
      expect(getComputedStyle(outlineActions).flexShrink).toBe('0')

      const paneWorkspace = screen.getByTestId('pane-workspace')
      expect(isZeroCssLength(getComputedStyle(paneWorkspace).minHeight)).toBe(true)
      expect(isZeroCssLength(getComputedStyle(paneWorkspace).minWidth)).toBe(true)
      expect(getComputedStyle(paneWorkspace).overflow).toBe('hidden')

      const assertPaneIsolation = (pane: HTMLElement, mode: 'raw' | 'wysiwyg' | 'preview'): void => {
        const paneStyle = getComputedStyle(pane)
        expect(isZeroCssLength(paneStyle.minHeight)).toBe(true)
        expect(isZeroCssLength(paneStyle.minWidth)).toBe(true)
        expect(paneStyle.overflow).toBe('hidden')

        const tabBar = within(pane).getByRole('tablist')
        expect(getComputedStyle(tabBar).flexShrink).toBe('0')

        const docEditor = within(pane).getByRole('region', { name: '문서 편집 영역' })
        const docEditorStyle = getComputedStyle(docEditor)
        expect(isZeroCssLength(docEditorStyle.minHeight)).toBe(true)
        expect(isZeroCssLength(docEditorStyle.minWidth)).toBe(true)
        expect(docEditorStyle.overflow).toBe('hidden')

        const editorHeader = within(docEditor)
          .getByRole('group', { name: '에디터 모드 전환' })
          .parentElement as HTMLElement
        expect(getComputedStyle(editorHeader).flexShrink).toBe('0')

        if (mode === 'raw') {
          const tableToolbar = within(docEditor).getByRole('toolbar', { name: 'Raw 표 편집 툴바' })
          expect(getComputedStyle(tableToolbar).flexShrink).toBe('0')
          const rawShell = tableToolbar.parentElement as HTMLElement
          expect(isZeroCssLength(getComputedStyle(rawShell).minHeight)).toBe(true)
          expect(getComputedStyle(rawShell).overflow).toBe('hidden')
          const rawEditorEl = within(docEditor).getByTestId('document-editor')
          const cmHost = rawEditorEl.closest('.codemirror-host') as HTMLElement
          expect(isZeroCssLength(getComputedStyle(cmHost).minHeight)).toBe(true)
          expect(getComputedStyle(cmHost).overflow).toBe('hidden')
          const rawScroller = getRawEditorScroller(rawEditorEl)
          expect(isZeroCssLength(getComputedStyle(rawScroller).minHeight)).toBe(true)
          expect(getComputedStyle(rawScroller).overflowY).toBe('auto')
        } else if (mode === 'wysiwyg') {
          const formatToolbar = within(docEditor).getByRole('toolbar', { name: '위지윅 서식 툴바' })
          expect(getComputedStyle(formatToolbar).flexShrink).toBe('0')
          const wysiwygShell = formatToolbar.parentElement as HTMLElement
          expect(isZeroCssLength(getComputedStyle(wysiwygShell).minHeight)).toBe(true)
          expect(getComputedStyle(wysiwygShell).overflow).toBe('hidden')
          const scrollContainer = within(docEditor)
            .getByTestId('document-editor')
            .closest('.wysiwyg-scroll-container') as HTMLElement
          expect(isZeroCssLength(getComputedStyle(scrollContainer).minHeight)).toBe(true)
          expect(getComputedStyle(scrollContainer).overflowY).toBe('auto')
        } else {
          const preview = within(docEditor).getByLabelText('마크다운 미리보기')
          expect(isZeroCssLength(getComputedStyle(preview).minHeight)).toBe(true)
          expect(getComputedStyle(preview).overflowY).toBe('auto')
        }
      }

      const primaryPane = screen.getByRole('region', { name: '주 편집기 영역' })
      assertPaneIsolation(primaryPane, 'raw')

      // Switch to 위지윅 mode in single pane
      await user.click(
        within(within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: '위지윅'
        })
      )
      assertPaneIsolation(primaryPane, 'wysiwyg')

      // Switch to Preview mode in single pane
      await user.click(
        within(within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Preview'
        })
      )
      assertPaneIsolation(primaryPane, 'preview')

      // Open second file and split horizontally (좌우 분할)
      await user.click(within(explorer).getByText('long-b.md'))
      const secondTab = within(primaryPane).getByRole('tab', { name: /long-b\.md/i })
      fireEvent.dragStart(secondTab)
      fireEvent.drop(await screen.findByTestId('split-drop-zone-horizontal'))
      expect(paneWorkspace).toHaveAttribute('data-split-mode', 'horizontal')

      const secondaryPane = screen.getByRole('region', { name: '보조 편집기 영역' })
      await user.click(
        within(within(secondaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: '위지윅'
        })
      )
      assertPaneIsolation(primaryPane, 'preview')
      assertPaneIsolation(secondaryPane, 'wysiwyg')

      // Switch to vertical split (상하 분할)
      fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /long-b\.md/i }))
      fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
      expect(paneWorkspace).toHaveAttribute('data-split-mode', 'vertical')
      assertPaneIsolation(primaryPane, 'preview')
      assertPaneIsolation(secondaryPane, 'wysiwyg')
    } finally {
      cleanup()
    }
  })

  it('isolates overflow for all three left sidebar views without clipping folder tree context menu or git branch selector', async () => {
    const user = userEvent.setup()
    const checkoutSpy = vi.fn(async (_workspacePath: string, branchName: string) => ({
      ...createEmptyGitStatus(true, 'C:/wiki/sidebar-overflow'),
      branch: branchName
    }))
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\sidebar-overflow',
        workspaces: {
          'C:\\wiki\\sidebar-overflow': {
            'doc.md': '# Doc'
          }
        },
        git: {
          status: async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/sidebar-overflow'),
            branch: 'main',
            ahead: 1,
            behind: 0,
            unstaged: [{ path: 'doc.md', status: 'M' }]
          }),
          branches: async () => ({
            current: 'main',
            isDetached: false,
            branches: [
              { name: 'main', current: true, upstream: 'origin/main' },
              { name: 'feature/layout', current: false, upstream: null }
            ]
          }),
          checkout: checkoutSpy
        }
      }
    )
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      // 1. Explorer view (Folder Tree)
      const explorer = await screen.findByRole('region', { name: '워크스페이스 탐색기' })
      assertSidebarPanelIsolation(
        explorer,
        explorer.firstElementChild as HTMLElement,
        within(explorer).getByRole('tree')
      )

      // Context menu uses fixed positioning with no transform/filter containing block on ancestors
      fireEvent.contextMenu(await within(explorer).findByText('doc.md'), { clientX: 80, clientY: 120 })
      const contextMenu = await screen.findByRole('menu')
      expect(getComputedStyle(contextMenu).position).toBe('fixed')
      for (const ancestor of [
        explorer,
        screen.getByRole('complementary', { name: '왼쪽 사이드바' }),
        screen.getByRole('main')
      ]) {
        const style = getComputedStyle(ancestor)
        expect(['', 'none']).toContain(style.transform)
        expect(['', 'none']).toContain(style.filter)
        expect(['', 'none']).toContain(style.contain)
      }
      await user.click(within(contextMenu).getByRole('menuitem', { name: '열기' }))
      expect(await screen.findByRole('tab', { name: 'doc.md' })).toBeInTheDocument()

      // 2. Git view (Git Panel)
      await clickActivityBarButton(user, 'Git')
      const gitPanel = screen.getByRole('region', { name: 'Git 소스 제어' })
      const gitHeader = within(gitPanel).getByText('Git').closest('.git-header') as HTMLElement
      for (const btn of within(gitHeader).getAllByRole('button')) {
        expect(btn).not.toHaveAttribute('aria-expanded')
      }
      const gitCommonArea = gitPanel.querySelector('.git-common-area') as HTMLElement
      expect(getComputedStyle(gitCommonArea).flexShrink).toBe('0')
      const gitSplitContainer = gitPanel.querySelector('.git-split-container') as HTMLElement
      expect(isZeroCssLength(getComputedStyle(gitSplitContainer).minHeight)).toBe(true)
      expect(getComputedStyle(gitSplitContainer).overflow).toBe('hidden')
      const accordionBodies = Array.from(
        gitPanel.querySelectorAll('.git-accordion-body')
      ) as HTMLElement[]
      expect(accordionBodies).toHaveLength(2)
      for (const accordionBody of accordionBodies) {
        assertSidebarPanelIsolation(gitPanel, gitHeader, accordionBody)
      }

      const branchSelect = within(gitPanel).getByLabelText('브랜치 선택') as HTMLSelectElement
      await user.selectOptions(branchSelect, 'feature/layout')
      await user.click(within(gitPanel).getByRole('button', { name: '브랜치 전환' }))
      await waitFor(() => {
        expect(checkoutSpy).toHaveBeenCalledWith('C:/wiki/sidebar-overflow', 'feature/layout')
      })

      // 3. Workspace view
      await clickActivityBarButton(user, '워크스페이스')
      const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
      assertSidebarPanelIsolation(
        workspaceView,
        workspaceView.firstElementChild as HTMLElement,
        workspaceView.lastElementChild as HTMLElement
      )
    } finally {
      cleanup()
    }
  })
})

function stubScrollLayout(
  el: HTMLElement,
  getGeometry: () => { scrollTop: number; scrollHeight: number; clientHeight: number; top: number }
): void {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => getGeometry().scrollTop,
    set: () => undefined
  })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => getGeometry().scrollHeight
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => getGeometry().clientHeight
  })
  el.getBoundingClientRect = () =>
    ({
      top: getGeometry().top,
      bottom: getGeometry().top + getGeometry().clientHeight,
      left: 0,
      right: 600,
      width: 600,
      height: getGeometry().clientHeight,
      x: 0,
      y: getGeometry().top,
      toJSON: () => ({})
    }) as DOMRect
}

function createHeadingRect(top: number): DOMRect {
  return {
    top,
    bottom: top + 28,
    left: 0,
    right: 500,
    width: 500,
    height: 28,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

function stubHeadingTop(el: HTMLElement, getTop: () => number): void {
  el.getBoundingClientRect = () => createHeadingRect(getTop())
}

function stubPreviewSpyLayout(
  preview: HTMLElement,
  docOffsets: number[],
  getScrollTop: () => number,
  {
    scrollHeight = 1000,
    clientHeight = 400,
    top = 100
  }: { scrollHeight?: number; clientHeight?: number; top?: number } = {}
): HTMLElement[] {
  stubScrollLayout(preview, () => ({
    scrollTop: getScrollTop(),
    scrollHeight,
    clientHeight,
    top
  }))
  const headings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[]
  expect(headings).toHaveLength(docOffsets.length)
  headings.forEach((el, idx) => {
    stubHeadingTop(el, () => top + docOffsets[idx] - getScrollTop())
  })
  return headings
}

describe('Document Outline active heading scroll spy in Preview mode', () => {
  it('tracks Preview scroll position in Document Outline with aria-current="location", auto-scroll, and no redundant updates within the same section', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const docContent = [
        'Intro preface before first heading.',
        '',
        '# Overview',
        'Section 1 body',
        '',
        '## Architecture',
        'Section 2 body',
        '',
        '### Details',
        'Section 3 body',
        '',
        '## Summary',
        'Short ending'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\outline-spy',
          workspaces: {
            'C:\\wiki\\outline-spy': {
              'guide.md': docContent,
              'plain.md': 'Just text without any headings',
              'notes.json': '{"ok":true}'
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('guide.md'))

      await user.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Preview'
        })
      )

      const preview = screen.getByLabelText('마크다운 미리보기')
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      // Stub layout: container top = 100, clientHeight = 400, scrollHeight = 1000
      let currentScrollTop = 0
      const docOffsets = [160, 340, 560, 880] // distance from document top (before scrollTop subtraction)
      stubPreviewSpyLayout(preview, docOffsets, () => currentScrollTop)

      // 1. Preface before first heading -> no outline item active
      fireEvent.scroll(preview)
      for (const btn of outlineButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // 2. Scroll to Overview (heading 0 at relativeTop = 100+160-150-100 = 10 <= 24)
      currentScrollTop = 150
      fireEvent.scroll(preview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[0]).toHaveClass('is-active')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoViewMock.mock.instances[0]).toBe(outlineButtons()[0])

      // 3. Scroll within Overview section (heading 0 stays active) -> no redundant auto-scroll
      scrollIntoViewMock.mockClear()
      currentScrollTop = 210
      fireEvent.scroll(preview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // 4. Scroll to Architecture (heading 1 at relativeTop = 340 - 330 = 10 <= 24)
      currentScrollTop = 330
      fireEvent.scroll(preview)
      expect(outlineButtons()[0]).not.toHaveAttribute('aria-current')
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(outlineButtons()[1])

      // 5. Scroll to container bottom (scrollTop = 600, Summary still below baseline at 280) -> Summary active
      currentScrollTop = 600
      fireEvent.scroll(preview)
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')

      // 6. Opening non-markdown file or markdown without headings clears active heading
      await user.click(within(explorer).getByText('notes.json'))
      expect(within(outline).queryByRole('list')).not.toBeInTheDocument()
      await user.click(within(explorer).getByText('plain.md'))
      expect(within(outline).queryByRole('list')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('protects clicked Document Outline heading until user scroll, clears pin on tab/Editor Mode switch, and ignores inactive Split Mode Pane scroll', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const guideDoc = [
        'Intro preface before first heading.',
        '',
        '# Overview',
        'Section 1 body',
        '',
        '## Architecture',
        'Section 2 body',
        '',
        '### Details',
        'Section 3 body',
        '',
        '## Summary',
        'Short ending'
      ].join('\n')
      const sideDoc = ['# Side Alpha', 'Alpha body', '', '## Side Beta', 'Beta body'].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\outline-pin',
          workspaces: {
            'C:\\wiki\\outline-pin': {
              'guide.md': guideDoc,
              'side.md': sideDoc
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('side.md'))
      await user.click(await within(explorer).findByText('guide.md'))

      await user.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Preview'
        })
      )

      const primaryPane = screen.getByTestId('pane-primary')
      let primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      let currentScrollTop = 150
      const docOffsets = [160, 340, 560, 880]
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // 1. Clicking short bottom heading ("Summary") pins it immediately and resists programmatic scroll overwrites
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[3]).toHaveClass('is-active')
      expect(outlineButtons()[0]).not.toHaveAttribute('aria-current')

      // Programmatic scroll fires while stopped before bottom (Architecture at top=10 <= 24, Summary still below baseline)
      currentScrollTop = 330
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')

      // Non-scroll prose click inside Preview does not arm user-scroll intent
      await user.click(within(primaryPreview).getByText('Section 1 body'))
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')

      // 2. Actual wheel scroll releases protection and lets scroll spy resume
      scrollIntoViewMock.mockClear()
      fireEvent.wheel(primaryPreview)
      currentScrollTop = 335
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoViewMock.mock.instances).toContain(outlineButtons()[1])

      // 3. Keyboard scroll (PageUp) also releases protection
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      fireEvent.keyDown(primaryPreview, { key: 'PageUp' })
      currentScrollTop = 150
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')

      // 4. Switching tabs clears click protection
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      await user.click(within(primaryPane).getByRole('tab', { name: /side\.md/i }))
      await user.click(within(primaryPane).getByRole('tab', { name: /guide\.md/i }))
      primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // 5. Switching mode (Ctrl+1 -> Ctrl+3) clears click protection
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      fireEvent.keyDown(window, { key: '1', ctrlKey: true })
      fireEvent.keyDown(window, { key: '3', ctrlKey: true })
      primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // 6. Scrolling an inactive Split Mode Pane's Preview does not overwrite active Pane's Document Outline highlight
      fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /side\.md/i }))
      const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
      await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

      const secondaryPane = screen.getByTestId('pane-secondary')
      await user.click(
        within(within(secondaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
          'button',
          { name: 'Preview' }
        )
      )

      // Keep primaryPane focused on guide.md at Overview (index 0)
      await user.click(within(primaryPane).getByRole('tab', { name: /guide\.md/i }))
      primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // Scroll inactive secondaryPreview to Side Beta (index 1) without activating secondaryPane
      const secondaryPreview = within(secondaryPane).getByLabelText('마크다운 미리보기')
      const secondaryScrollTop = 450
      stubPreviewSpyLayout(secondaryPreview, [60, 460], () => secondaryScrollTop)
      fireEvent.wheel(secondaryPreview)
      fireEvent.scroll(secondaryPreview)

      expect(outlineButtons()).toHaveLength(4)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')
    } finally {
      restore()
    }
  })
})

describe('Document Outline scroll spy in Raw, 위지윅, Tab/Editor Mode switches, and Split Mode Panes', () => {
  it('tracks scroll, content edits, click pin protection, and user-scroll release in 위지윅 Editor Mode', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const docContent = [
        'Intro preface before first heading.',
        '',
        '# Overview',
        'Section 1 body',
        '',
        '## Architecture',
        'Section 2 body',
        '',
        '### Details',
        'Section 3 body',
        '',
        '## Summary',
        'Short ending'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\wysiwyg-spy',
          workspaces: {
            'C:\\wiki\\wysiwyg-spy': {
              'guide.md': docContent
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('guide.md'))

      await user.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: '위지윅'
        })
      )

      const primaryPane = screen.getByTestId('pane-primary')
      const scrollContainer = primaryPane.querySelector('.wysiwyg-scroll-container') as HTMLElement
      expect(scrollContainer).toBeTruthy()

      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      let currentScrollTop = 0
      const headingOffsets = new Map<string, number>([
        ['Overview', 160],
        ['Architecture', 340],
        ['Details', 560],
        ['Summary', 880]
      ])

      stubScrollLayout(scrollContainer, () => ({
        scrollTop: currentScrollTop,
        scrollHeight: 1000,
        clientHeight: 400,
        top: 100
      }))

      const originalRect = HTMLElement.prototype.getBoundingClientRect
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (/^H[1-6]$/.test(this.tagName) && scrollContainer.contains(this)) {
            const text = this.textContent?.trim() ?? ''
            const offset = headingOffsets.get(text) ?? 0
            return createHeadingRect(100 + offset - currentScrollTop)
          }
          return originalRect.call(this)
        })

      try {
        // 1. Preface at top -> none active
        fireEvent.scroll(scrollContainer)
        for (const btn of outlineButtons()) {
          expect(btn).not.toHaveAttribute('aria-current')
        }

        // 2. Scroll to Architecture -> index 1 active and auto-scrolled in Document Outline
        scrollIntoViewMock.mockClear()
        currentScrollTop = 320
        fireEvent.scroll(scrollContainer)
        expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
        expect(outlineButtons()[1]).toHaveClass('is-active')
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

        // 3. Click Summary in Document Outline -> pin protected until explicit user scroll
        await user.click(outlineButtons()[3])
        expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
        currentScrollTop = 330
        fireEvent.scroll(scrollContainer)
        expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')

        // User wheel scroll releases pin and tracks active heading cleanly
        fireEvent.wheel(scrollContainer)
        currentScrollTop = 335
        fireEvent.scroll(scrollContainer)
        expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

        // 4. Editing content inserts a new heading above Architecture, recalculating active index
        headingOffsets.set('Intro preface before first heading.', 80)
        const docEl = within(primaryPane).getByTestId('document-editor')
        const firstParagraph = docEl.querySelector('p')!
        const docWithElementFromPoint = document as Document & {
          elementFromPoint?: (x: number, y: number) => Element | null
        }
        const hadOwnElementFromPoint = Object.prototype.hasOwnProperty.call(
          docWithElementFromPoint,
          'elementFromPoint'
        )
        const prevElementFromPoint = docWithElementFromPoint.elementFromPoint
        docWithElementFromPoint.elementFromPoint = () => firstParagraph
        try {
          await user.click(firstParagraph)
        } finally {
          if (hadOwnElementFromPoint) {
            docWithElementFromPoint.elementFromPoint = prevElementFromPoint
          } else {
            Reflect.deleteProperty(docWithElementFromPoint, 'elementFromPoint')
          }
        }
        await user.click(within(primaryPane).getByRole('button', { name: 'H1' }))
        await waitFor(() => {
          expect(outlineButtons()).toHaveLength(5)
        })
        expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')
      } finally {
        rectSpy.mockRestore()
      }
    } finally {
      restore()
    }
  })

  it('tracks Raw scroll by 1-based top line (excluding code fences), content edits, click pin protection, and ignores cursor-only moves', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const rawDoc = [
        'Preface intro line 1',
        '# Alpha Heading',
        '```bash',
        '# bash comment inside fence',
        'echo ok',
        '```',
        '## Beta Heading',
        'Beta paragraph line 8',
        '### Gamma Heading',
        'Closing line 10'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\raw-spy',
          workspaces: {
            'C:\\wiki\\raw-spy': {
              'raw-guide.md': rawDoc
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('raw-guide.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      const scroller = primaryPane.querySelector('.cm-scroller') as HTMLElement
      expect(scroller).toBeTruthy()
      const rawEditorEl = within(primaryPane).getByTestId('document-editor')
      const rawView = getRawEditorView(rawEditorEl)

      let currentScrollTop = 0
      stubScrollLayout(scroller, () => ({
        scrollTop: currentScrollTop,
        scrollHeight: 500,
        clientHeight: 200,
        top: 100
      }))

      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')
      expect(outlineButtons()).toHaveLength(3)

      // 1. Preface at scrollTop=0 -> none active
      fireEvent.scroll(scroller)
      for (const btn of outlineButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }

      // 2. Scroll onto fenced `# bash comment` (line 4, scrollTop=42) -> stays on # Alpha Heading (index 0)
      scrollIntoViewMock.mockClear()
      currentScrollTop = 42
      fireEvent.scroll(scroller)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[0]).toHaveClass('is-active')
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // 3. Cursor movement alone without scrolling does NOT shift Document Outline highlight
      const endPos = rawView.state.doc.length
      act(() => {
        rawView.dispatch({ selection: { anchor: endPos } })
      })
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[2]).not.toHaveAttribute('aria-current')

      // 4. Click Gamma Heading (index 2) -> pin protected across programmatic scroll; wheel releases pin
      await user.click(outlineButtons()[2])
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')
      currentScrollTop = 84 // Line 7: Beta Heading
      fireEvent.scroll(scroller)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      fireEvent.wheel(scroller)
      fireEvent.scroll(scroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // 5. Scroll to bottom (scrollHeight 500, clientHeight 200, scrollTop 299) -> highlights last heading
      currentScrollTop = 299
      fireEvent.scroll(scroller)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      // 6. Editing Raw content shifts heading indices at the same scroll position (scrollTop=100, line 8)
      fireEvent.wheel(scroller)
      currentScrollTop = 100
      fireEvent.scroll(scroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      setRawEditorText(rawEditorEl, '# Prepended Top\n' + rawDoc)
      expect(outlineButtons()).toHaveLength(4)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')
    } finally {
      restore()
    }
  })

  it('synchronizes Document Outline immediately across Editor Mode switches, same-Pane Tab switches, and Split Mode Pane focus switches', async () => {
    const user = userEvent.setup()
    const { restore } = mockPrototypeScrollIntoView()

    try {
      const alphaDoc = [
        'Alpha preface',
        '# Alpha One',
        'Alpha paragraph',
        '## Alpha Two',
        'Alpha section',
        '### Alpha Three',
        'Alpha ending'
      ].join('\n')
      const betaDoc = [
        'Beta preface',
        '# Beta One',
        'Beta paragraph',
        '## Beta Two',
        'Beta ending'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\sync-modes',
          workspaces: {
            'C:\\wiki\\sync-modes': {
              'alpha.md': alphaDoc,
              'beta.md': betaDoc,
              'meta.json': '{"name":"wiki"}'
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('beta.md'))
      await user.click(await within(explorer).findByText('meta.json'))
      await user.click(await within(explorer).findByText('alpha.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      // 1. Raw -> 위지윅 -> Preview Editor Mode switches immediately recalculate active heading
      const rawScroller = primaryPane.querySelector('.cm-scroller') as HTMLElement
      let alphaScrollTop = 42 // Line 4: ## Alpha Two
      stubScrollLayout(rawScroller, () => ({
        scrollTop: alphaScrollTop,
        scrollHeight: 500,
        clientHeight: 200,
        top: 100
      }))
      fireEvent.scroll(rawScroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // Pin heading 2 then switch Editor Mode to 위지윅 -> pin clears and new mode recalculates
      await user.click(outlineButtons()[2])
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      await user.click(
        within(within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
          'button',
          { name: '위지윅' }
        )
      )
      const wysiwygContainer = primaryPane.querySelector('.wysiwyg-scroll-container') as HTMLElement
      alphaScrollTop = 0
      stubPreviewSpyLayout(wysiwygContainer, [120, 320, 520], () => alphaScrollTop)
      // Trigger measurement on stubbed WYSIWYG container -> heading 0 active on mode change vs top
      fireEvent.scroll(wysiwygContainer)
      for (const btn of outlineButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }

      // Switch to Preview mode and scroll to Alpha Two (index 1)
      await user.click(
        within(within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
          'button',
          { name: 'Preview' }
        )
      )
      const primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      alphaScrollTop = 310
      stubPreviewSpyLayout(primaryPreview, [120, 320, 520], () => alphaScrollTop)
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // 2. Same-Pane Tab switch to non-markdown (.json) clears Document Outline, returning restores Alpha Two
      await user.click(within(primaryPane).getByRole('tab', { name: /meta\.json/i }))
      expect(within(outline).queryByRole('list')).not.toBeInTheDocument()

      await user.click(within(primaryPane).getByRole('tab', { name: /alpha\.md/i }))
      const restoredPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(restoredPreview, [120, 320, 520], () => alphaScrollTop)
      fireEvent.scroll(restoredPreview)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // 3. Split Mode (좌우 분할): move beta.md to Secondary Pane while keeping Primary Pane active
      fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /beta\.md/i }))
      const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
      await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

      const secondaryPane = screen.getByTestId('pane-secondary')
      // Click back into Primary Pane so Alpha Two remains active
      fireEvent.mouseDown(within(primaryPane).getByLabelText('마크다운 미리보기'))
      expect(outlineButtons()).toHaveLength(3)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // Pin Alpha Three in Primary Pane, then scroll INACTIVE Secondary Pane (Raw beta.md) to ## Beta Two
      await user.click(outlineButtons()[2])
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      const secondaryScroller = secondaryPane.querySelector('.cm-scroller') as HTMLElement
      let betaScrollTop = 42 // Line 4: ## Beta Two (index 1)
      stubScrollLayout(secondaryScroller, () => ({
        scrollTop: betaScrollTop,
        scrollHeight: 500,
        clientHeight: 200,
        top: 100
      }))
      fireEvent.wheel(secondaryScroller)
      fireEvent.scroll(secondaryScroller)

      // Active Primary Pane's Document Outline & pin must remain untouched by inactive Pane scroll
      expect(outlineButtons()).toHaveLength(3)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      // 4. Focusing Secondary Pane immediately syncs Document Outline to Beta Two WITHOUT resetting to null or scrolling
      fireEvent.mouseDown(secondaryScroller)
      expect(outlineButtons()).toHaveLength(2)
      expect(within(outline).getByText('Beta One')).toBeInTheDocument()
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).toHaveClass('is-active')

      // 5. Switch Split Mode to vertical (상하 분할) and focus back to Primary Pane -> immediately restores Alpha Two (pin was cleared on focus switch)
      fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /beta\.md/i }))
      fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')
      fireEvent.mouseDown(within(primaryPane).getByLabelText('마크다운 미리보기'))
      expect(outlineButtons()).toHaveLength(3)
      expect(within(outline).getByText('Alpha Two')).toBeInTheDocument()
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // Verify inactive Secondary Pane can also scroll to top while Primary Pane is focused without affecting Primary Pane
      betaScrollTop = 0
      fireEvent.wheel(secondaryScroller)
      fireEvent.scroll(secondaryScroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
    } finally {
      restore()
    }
  })
})

describe('Split editor mode and bidirectional scroll sync', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('integrates Split mode live preview/Mermaid, per-tab clamped splitter ratio, 2-pane workspace independence, non-markdown lock, Outline TOC cursor insertion, and split breadcrumbs', async () => {
    const user = userEvent.setup()
    const entries: RendererLogPayload[] = []
    const alphaInitial = [
      '# SECRET_ALPHA_TITLE',
      '',
      '## Intro',
      '',
      '## Details',
      '',
      '```mermaid',
      'flowchart LR',
      '  Start --> InitialNode',
      '```'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-mode',
        workspaces: {
          'C:/wiki/split-mode': {
            'alpha.md': alphaInitial,
            'beta.md': '# SECRET_BETA_TITLE',
            'notes.txt': 'plain text file'
          }
        },
        log: {
          write: (payload) => {
            entries.push(payload)
            return Promise.resolve()
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    // Non-markdown .txt buffer locks Split button and Ctrl+4 / Ctrl+Shift+M
    await user.click(await within(explorer).findByText('notes.txt'))
    const primaryPane = screen.getByTestId('pane-primary')
    const primaryModeGroup = within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })
    expect(within(primaryModeGroup).getByRole('button', { name: 'Split' })).toBeDisabled()
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '4', ctrlKey: true })
    fireEvent.keyDown(window, { key: '4', ctrlKey: true })
    expect(within(primaryPane).queryByTestId('split-markdown-preview')).not.toBeInTheDocument()

    // Open alpha.md and switch to Split via Ctrl+4
    await user.click(within(explorer).getByText('alpha.md'))
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '4', ctrlKey: true })
    const alphaPreview = within(primaryPane).getByTestId('split-markdown-preview')
    const alphaModeGroup = within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })
    expect(within(alphaModeGroup).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(primaryPane).getByRole('toolbar', { name: 'Raw 표 편집 툴바' })).toBeInTheDocument()

    // Edit Mermaid diagram & heading in left Raw editor -> live right Preview updates
    const alphaUpdated = alphaInitial
      .replace('SECRET_ALPHA_TITLE', 'SECRET_ALPHA_UPDATED')
      .replace('InitialNode', 'LiveUpdatedNode')
    setRawEditorText(within(primaryPane).getByTestId('document-editor'), alphaUpdated)
    expect(within(alphaPreview).getByRole('heading', { level: 1 }).textContent).toContain(
      'SECRET_ALPHA_UPDATED'
    )
    await waitFor(() => {
      expect(mermaidMockState.render).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('LiveUpdatedNode')
      )
      expect(within(alphaPreview).getByTestId('mermaid-svg')).toBeInTheDocument()
    })

    // Adjust internal split splitter via drag + double-click + ArrowRight, and persist per tab across tab & mode switches
    const alphaSplitter = within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    const alphaContainer = within(primaryPane).getByTestId('editor-split-container')
    vi.spyOn(alphaContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({})
    })
    fireEvent.mouseDown(alphaSplitter)
    fireEvent.mouseMove(window, { clientX: 600 })
    fireEvent.mouseUp(window)
    expect(alphaSplitter).toHaveAttribute('aria-valuenow', '60')

    fireEvent.doubleClick(alphaSplitter)
    expect(alphaSplitter).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(alphaSplitter, { key: 'ArrowRight' })
    fireEvent.keyDown(alphaSplitter, { key: 'ArrowRight' })
    fireEvent.keyDown(alphaSplitter, { key: 'ArrowRight' })
    expect(alphaSplitter).toHaveAttribute('aria-valuenow', '65')

    // Switch to beta.md -> back to alpha.md -> toggle Raw -> Split: ratio 65 stays preserved for alpha.md
    await user.click(within(explorer).getByText('beta.md'))
    await user.click(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))
    expect(
      within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '65')

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '1', ctrlKey: true })
    expect(within(primaryPane).queryByTestId('split-markdown-preview')).not.toBeInTheDocument()
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '4', ctrlKey: true })
    expect(
      within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '65')

    // Outline '본문에 목차 삽입' in Split mode inserts TOC at Raw cursor line (not top fallback)
    const cursorPos = alphaUpdated.indexOf('## Details')
    setRawEditorSelection(within(primaryPane).getByTestId('document-editor'), cursorPos, cursorPos)
    const outlineSidebar = screen.getByLabelText('문서 목차 (Outline)')
    await user.click(within(outlineSidebar).getByRole('button', { name: '본문에 목차 삽입' }))

    const textAfterToc = getRawEditorText(within(primaryPane).getByTestId('document-editor'))
    expect(textAfterToc.indexOf('<!-- toc -->')).toBeGreaterThan(-1)
    expect(textAfterToc.indexOf('<!-- toc -->')).toBeGreaterThan(
      textAfterToc.indexOf('## Intro')
    )

    // Workspace 2-pane split + Editor Split mode coexistence & independent splitters
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /beta\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')
    await user.click(
      within(within(secondaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Split' }
      )
    )
    const secondarySplitter = within(secondaryPane).getByRole('separator', {
      name: '에디터 분할 크기 조절'
    })
    expect(secondarySplitter).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(secondarySplitter, { key: 'ArrowLeft' })
    fireEvent.keyDown(secondarySplitter, { key: 'ArrowLeft' })
    expect(secondarySplitter).toHaveAttribute('aria-valuenow', '40')

    // Primary editor splitter & workspace splitter remain completely independent
    expect(
      within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '65')
    expect(screen.getByRole('separator', { name: '화면 분할 크기 조절' })).toHaveAttribute(
      'aria-valuenow',
      '50'
    )

    // Breadcrumb logs include 'split' transitions with zero content leakage
    const modeChanges = entries.filter(
      (entry) => entry.category === 'ui' && entry.message === 'Editor mode changed'
    )
    expect(modeChanges.map((entry) => ({ from: entry.data?.from, to: entry.data?.to }))).toEqual([
      { from: 'raw', to: 'split' },
      { from: 'split', to: 'raw' },
      { from: 'raw', to: 'split' },
      { from: 'raw', to: 'split' }
    ])
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('SECRET_ALPHA')
    expect(serialized).not.toContain('SECRET_BETA')
  })

  it('synchronizes Split mode scroll bidirectionally with PaneTabStore persistence and jumps both Raw and Preview on Outline click', async () => {
    const user = userEvent.setup()
    const scrollIntoViewMock = vi.fn()
    const origScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView'
    )
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const mermaidBlock = [
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  C --> D',
        '  D --> E',
        '  E --> F',
        '```'
      ]
      const listItems = Array.from({ length: 40 }, (_, i) => `- Item ${i + 1}`)
      const docContent = [
        '# Overview',
        '',
        ...mermaidBlock, // lines 3..10
        '',
        '## Architecture', // line 12
        '',
        ...listItems // lines 14..53
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { autoSave: false, showHeadingNumbers: false },
        {
          selectedFolder: 'C:/wiki/split-scroll',
          workspaces: {
            'C:/wiki/split-scroll': {
              'diagram-doc.md': docContent
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('diagram-doc.md'))

      // Switch to Split mode via Ctrl+4
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
      const previewRegion = screen.getByTestId('split-markdown-preview')
      await waitFor(() => {
        expect(within(previewRegion).getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      // Verify post-sanitize top-level source line annotations
      const h1El = previewRegion.querySelector('h1[data-source-line="1"]') as HTMLElement
      const mermaidEl = within(previewRegion).getByTestId('mermaid-diagram')
      const h2El = previewRegion.querySelector('h2[data-source-line="12"]') as HTMLElement
      const ulEl = previewRegion.querySelector('ul[data-source-line="14"]') as HTMLElement
      expect(mermaidEl).toHaveAttribute('data-source-line', '3')
      expect(mermaidEl).toHaveAttribute('data-source-end-line', '10')
      expect(ulEl).toHaveAttribute('data-source-end-line', '53')

      const rawEditorEl = screen.getByTestId('document-editor')
      const cmView = getRawEditorView(rawEditorEl)
      const rawScroller = getRawEditorScroller(rawEditorEl)

      Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(rawScroller, 'scrollHeight', {
        configurable: true,
        get: () => cmView.contentHeight
      })
      Object.defineProperty(previewRegion, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(previewRegion, 'scrollHeight', { configurable: true, value: 1480 })
      previewRegion.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 500, bottom: 200, width: 500, height: 200, x: 0, y: 0, toJSON: () => ({}) })

      const mockRect = (el: HTMLElement, docTop: number, height: number) => {
        el.getBoundingClientRect = () => {
          const y = docTop - previewRegion.scrollTop
          return { top: y, left: 0, right: 500, bottom: y + height, width: 500, height, x: 0, y, toJSON: () => ({}) }
        }
      }
      mockRect(h1El, 0, 40)
      mockRect(mermaidEl, 60, 560)
      mockRect(h2El, 640, 40)
      mockRect(ulEl, 700, 780)

      // 1. Raw -> Preview interpolation inside Mermaid block (line 7 = 50% of [3, 11] => 60 + 0.5*560 = 340)
      const line7Top = cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(7).from).top
      rawScroller.scrollTop = line7Top
      fireEvent.scroll(rawScroller)
      expect(previewRegion.scrollTop).toBeCloseTo(340, 5)

      // Echo scroll on Preview does not ping-pong back to Raw
      fireEvent.scroll(previewRegion)
      expect(rawScroller.scrollTop).toBe(line7Top)

      // 2. Preview -> Raw interpolation in list (50% of [14, 54] => line 34, 700 + 0.5*780 = 1090)
      previewRegion.scrollTop = 1090
      fireEvent.scroll(previewRegion)
      const expectedLine34Top =
        cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(34).from).top
      expect(rawScroller.scrollTop).toBeCloseTo(expectedLine34Top, 5)

      // Switching Split -> Raw restores synced scrollTop persisted in PaneTabStore
      fireEvent.keyDown(rawEditorEl, { key: '1', ctrlKey: true })
      const rawOnlyEditor = screen.getByTestId('document-editor')
      expect(getRawEditorScroller(rawOnlyEditor).scrollTop).toBeCloseTo(expectedLine34Top, 5)

      // Switch back to Split and test Outline heading jump scrolls both Raw and Preview
      fireEvent.keyDown(rawOnlyEditor, { key: '4', ctrlKey: true })
      scrollIntoViewMock.mockClear()

      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const archBtn = within(outline).getByRole('button', { name: /Architecture/ })
      await user.click(archBtn)

      await waitFor(() => {
        expect(getRawEditorSelection(screen.getByTestId('document-editor')).start).toBe(
          docContent.indexOf('## Architecture')
        )
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
        expect(archBtn).toHaveAttribute('aria-current', 'location')
      })
      const jumpedPreview = screen.getByTestId('split-markdown-preview')
      const jumpedArchHeading = within(jumpedPreview).getByRole('heading', { level: 2, name: 'Architecture' })
      expect(scrollIntoViewMock.mock.instances).toContain(jumpedArchHeading)
    } finally {
      if (origScrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origScrollIntoViewDescriptor)
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
    }
  })
})
