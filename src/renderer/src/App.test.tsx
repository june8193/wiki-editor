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
import { createEmptyGitStatus, type GitFileStatusCode } from '@shared/git'
import type { AppMenuCommand, WikiApi, WikiGitApi, WikiLogApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import {
  addFavoriteWorkspace,
  compareWorkspaceEntriesByRelativePath,
  getWorkspaceDisplayName,
  isMarkdownFileName,
  recordRecentWorkspace,
  removeFavoriteWorkspace,
  toggleFavoriteWorkspace,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind
} from '@shared/workspace'
import { defaultMermaidRenderer } from './editor/mermaidRenderer'
import { App } from './App'

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
      async listMarkdownFiles() {
        if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
        const prefix = `${activeRoot}/`
        const ignoredSegments = new Set(['.git', 'node_modules', '.hg', '.svn', '.DS_Store', 'Thumbs.db'])
        const markdownEntries: WorkspaceEntry[] = []
        for (const file of files.keys()) {
          if (!file.startsWith(prefix)) continue
          const relativePath = file.slice(prefix.length)
          if (relativePath.split('/').some((seg) => ignoredSegments.has(seg))) continue
          const name = baseNameOf(file)
          if (!isMarkdownFileName(name)) continue
          markdownEntries.push({
            name,
            path: file,
            relativePath,
            kind: 'file'
          })
        }
        return markdownEntries.sort(compareWorkspaceEntriesByRelativePath)
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
        recentWorkspaces: [],
        customCommands: []
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

    // Roundtrip Raw -> 위지윅 -> Preview -> Raw without editing must keep buffer clean and formatting intact
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
    const scrollIntoViewMock = vi.fn()
    const origScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView'
    )
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

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
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)

      // Toggle showHeadingNumbers off via Outline button -> hides numbers without dirtying buffer or re-scrolling
      await user.click(within(outline).getByRole('button', { name: '헤딩 번호 표시' }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('heading', { level: 2, name: 'Setup' }).textContent).toBe('Setup')
      expect(within(outline).queryByText('1.1.')).not.toBeInTheDocument()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(getFilesSnapshot().get('C:/wiki/outline/guide.md')).toBe(guideDoc)

      // Verify WYSIWYG mode reflects dynamic heading numbering toggle and one-shot click-to-scroll too
      await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
      scrollIntoViewMock.mockClear()
      const currentItems = within(within(outline).getByRole('list')).getAllByRole('listitem')
      await user.click(within(currentItems[1]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)

      // Open SettingsPanel, verify checkbox reflects false, toggle back true without re-scrolling and verify persistence across restart
      await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
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
      if (origScrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origScrollIntoViewDescriptor)
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
    }
  })

  it('inserts /toc and writes/strips heading numbers outside code fences with split-pane sync', async () => {
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

    // Run "본문에 목차(/toc) 삽입"
    await user.click(within(outline).getByRole('button', { name: '본문에 목차(/toc) 삽입' }))
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

  it('replaces non-fenced /toc placeholder when running Outline insert TOC in WYSIWYG mode', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: false },
      {
        selectedFolder: 'C:\\wiki\\wysiwyg-toc',
        workspaces: {
          'C:\\wiki\\wysiwyg-toc': {
            'doc.md': ['# Heading', '', '/toc', '', '## Details'].join('\n')
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
    await user.click(within(outline).getByRole('button', { name: '본문에 목차(/toc) 삽입' }))

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
    expect(rawText).not.toMatch(/^\/toc$/m)
  })

  it('does not replay stale outlineScrollRequest after tab switch or global Ctrl+1/Ctrl+3 shortcuts', async () => {
    const origScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView'
    )
    const scrollIntoViewMock = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock
    })

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
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)

      scrollIntoViewMock.mockClear()
      await user.click(screen.getByRole('tab', { name: 'beta.md' }))
      await user.click(screen.getByRole('tab', { name: 'alpha.md' }))
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      await user.click(within(outline).getByRole('button', { name: /Target Heading/i }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)

      scrollIntoViewMock.mockClear()
      fireEvent.keyDown(window, { key: '1', ctrlKey: true })
      expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')
      fireEvent.keyDown(window, { key: '3', ctrlKey: true })
      expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    } finally {
      if (origScrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origScrollIntoViewDescriptor)
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
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
      within(rightSidebar).getByRole('button', { name: '본문에 목차(/toc) 삽입' })
    ).toBeDisabled()

    await user.click(await within(explorer).findByText('notes.txt'))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBe(rightSidebar)
    expect(
      within(rightSidebar).getByText('마크다운 문서에서만 목차를 지원합니다.')
    ).toBeInTheDocument()
    expect(
      within(rightSidebar).getByRole('button', { name: '본문에 목차(/toc) 삽입' })
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

describe('Custom slash commands, Settings UI management, and direct config.json sync', () => {
  it('manages custom slash commands in Settings UI with validation, live preview, config.json persistence, and real-time editor sync', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\slash-settings',
        workspaces: {
          'C:\\wiki\\slash-settings': {
            'notes.md': '# Notes\n\n'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(within(sidebar).getByText('notes.md'))

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const settingsPanel = screen.getByLabelText('전역 설정 패널')

    // Built-in default seed commands appear in Settings UI
    const commandList = within(settingsPanel).getByRole('list', { name: '커스텀 명령어 목록' })
    expect(within(commandList).getByText('/function')).toBeInTheDocument()
    expect(within(commandList).getByText('/struct')).toBeInTheDocument()
    expect(within(commandList).getByText('/table')).toBeInTheDocument()
    expect(within(commandList).getByText('/mermaid')).toBeInTheDocument()
    expect(within(commandList).getByText('/toc')).toBeInTheDocument()

    // Rejects whitespace in trigger and does not emit role="alert"
    const triggerInput = within(settingsPanel).getByLabelText(/트리거명/i)
    const labelInput = within(settingsPanel).getByLabelText(/^라벨$/i)
    const descInput = within(settingsPanel).getByLabelText(/설명/i)
    const templateInput = within(settingsPanel).getByLabelText(/마크다운 템플릿/i)

    await user.type(triggerInput, 'bad cmd')
    await user.type(labelInput, '잘못된 명령어')
    await user.click(within(settingsPanel).getByRole('button', { name: '명령어 추가' }))
    expect(within(settingsPanel).getByTestId('custom-command-error')).toHaveTextContent('공백')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Rejects duplicate trigger
    await user.clear(triggerInput)
    await user.type(triggerInput, 'function')
    await user.click(within(settingsPanel).getByRole('button', { name: '명령어 추가' }))
    expect(within(settingsPanel).getByTestId('custom-command-error')).toHaveTextContent('이미 존재')

    // Add valid multiline command with live preview using active document title
    await user.clear(triggerInput)
    await user.type(triggerInput, 'note')
    await user.clear(labelInput)
    await user.type(labelInput, '노트 박스')
    await user.type(descInput, '문서 메모 블록')
    fireEvent.change(templateInput, {
      target: { value: '> **{{title}}**\n>\n> {{cursor}}내용' }
    })

    const preview = within(settingsPanel).getByTestId('custom-command-preview')
    expect(preview).toHaveTextContent('notes')
    expect(preview).toHaveTextContent('내용')

    await user.click(within(settingsPanel).getByRole('button', { name: '명령어 추가' }))
    expect(within(commandList).getByText('/note')).toBeInTheDocument()

    // Edit existing /struct command and delete /table command
    await user.click(within(commandList).getByRole('button', { name: '/struct 수정' }))
    fireEvent.change(templateInput, {
      target: { value: '### CustomStruct: {{cursor}}' }
    })
    await user.click(within(settingsPanel).getByRole('button', { name: '명령어 저장' }))

    await user.click(within(commandList).getByRole('button', { name: '/table 삭제' }))
    expect(within(commandList).queryByText('/table')).not.toBeInTheDocument()

    const persistedRaw = JSON.parse(await api.config.readRaw()) as AppConfig
    expect(persistedRaw.customCommands.some((c) => c.trigger === 'note')).toBe(true)
    expect(persistedRaw.customCommands.some((c) => c.trigger === 'table')).toBe(false)
    expect(
      persistedRaw.customCommands.find((c) => c.trigger === 'struct')?.template
    ).toBe('### CustomStruct: {{cursor}}')

    // Close settings and verify active Raw editor reflects changes immediately
    await user.click(within(settingsPanel).getByRole('button', { name: '닫기' }))

    const rawEditor = screen.getByTestId('document-editor')
    const rawEnd = getRawEditorText(rawEditor).length
    setRawEditorSelection(rawEditor, rawEnd, rawEnd)
    rawEditor.focus()

    await user.keyboard('/ta')
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()

    await user.keyboard('{Backspace}{Backspace}{Backspace}/no')
    const listbox = await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })
    expect(within(listbox).getByRole('option', { name: /\/note/ })).toBeInTheDocument()
    await user.click(within(listbox).getByRole('option', { name: /\/note/ }))

    expect(getRawEditorText(rawEditor)).toContain('> **notes**')
    expect(getRawEditorText(rawEditor)).toContain('> 내용')

    // Switch to WYSIWYG mode and verify edited custom command is live there too
    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: '위지윅'
      })
    )
    const wysiwygEl = screen.getByTestId('document-editor')
    expect(wysiwygEl).toHaveTextContent('notes')
    const pEls = wysiwygEl.querySelectorAll('p')
    const lastP = pEls[pEls.length - 1]
    const range = document.createRange()
    range.selectNodeContents(lastP)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    wysiwygEl.focus()
    document.dispatchEvent(new Event('selectionchange'))

    await user.keyboard(' /str')
    const wysiwygListbox = await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })
    await user.click(within(wysiwygListbox).getByRole('option', { name: /\/struct/ }))
    await waitFor(() => {
      expect(wysiwygEl).toHaveTextContent('CustomStruct:')
    })
  })

  it('validates direct config.json edits on Ctrl+S, preserves last valid config on error, and applies valid new commands', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\raw-config-slash',
        workspaces: {
          'C:\\wiki\\raw-config-slash': {
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
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    const configEditor = await screen.findByTestId('document-editor')
    const beforeConfig = await api.config.get()

    // Invalid duplicate custom command trigger -> Ctrl+S shows alert and preserves previous valid config
    const invalidJsonConfig = JSON.stringify(
      {
        ...beforeConfig,
        customCommands: [
          { trigger: 'dup', label: 'First', template: 'one' },
          { trigger: 'dup', label: 'Second', template: 'two' }
        ]
      },
      null,
      2
    )
    setRawEditorText(configEditor, invalidJsonConfig)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    expect(await screen.findByRole('alert')).toHaveTextContent('customCommands')
    expect((await api.config.get()).customCommands).toEqual(beforeConfig.customCommands)

    // Invalid JSON syntax also shows alert and keeps last valid config
    setRawEditorText(configEditor, '{ invalid json')
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect((await api.config.get()).customCommands).toEqual(beforeConfig.customCommands)

    // Fix config.json with valid new /api command -> Ctrl+S clears error and activates /api in guide.md
    const validJsonConfig = JSON.stringify(
      {
        ...beforeConfig,
        customCommands: [
          ...beforeConfig.customCommands,
          {
            trigger: 'api',
            label: 'API 엔드포인트',
            description: 'REST API 문서',
            template: '#### API ({{title}}): {{cursor}}'
          }
        ]
      },
      null,
      2
    )
    setRawEditorText(configEditor, validJsonConfig)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole('tab', { name: 'guide.md' }))
    const mdEditor = screen.getByTestId('document-editor')
    const endPos = getRawEditorText(mdEditor).length
    setRawEditorSelection(mdEditor, endPos, endPos)
    mdEditor.focus()

    await user.keyboard('/ap')
    const listbox = await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })
    expect(within(listbox).getByRole('option', { name: /\/api/ })).toBeInTheDocument()
    await user.click(within(listbox).getByRole('option', { name: /\/api/ }))

    expect(getRawEditorText(mdEditor)).toContain('#### API (guide): ')
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

describe('Link autocomplete menu & Ctrl+K integration', () => {
  it('supports Raw and WYSIWYG body/table section links, priority matching, [`symbol`] code mark, pipe escaping, and matches TOC/Preview slugs', async () => {
    const user = userEvent.setup()
    const initialMd = [
      '# 1.1. 개요',
      '',
      '## `buildTree`',
      '',
      '## A | B 표기',
      '',
      '| 함수 | 설명 |',
      '| --- | --- |',
      '| target |  |',
      '',
      '본문 '
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'api.md': initialMd
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('api.md'))

    const rawEl = await screen.findByTestId('document-editor')
    const rawView = getRawEditorView(rawEl)

    // 1) Raw 요약 테이블 셀 내 [함수명]( 우선순위 추천 + 완성
    const cellInsertAt = rawView.state.doc.toString().indexOf('| target |  |') + '| target | '.length
    act(() => {
      rawView.dispatch({
        changes: { from: cellInsertAt, to: cellInsertAt, insert: '[buildTree](' },
        selection: { anchor: cellInsertAt + '[buildTree]('.length }
      })
    })

    const rawListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(rawListbox).getAllByRole('option')[0]).toHaveTextContent('buildTree')
    fireEvent.keyDown(rawEl, { key: 'Enter' })

    expect(getRawEditorText(rawEl)).toContain('| target | [buildTree](#buildtree) |')

    // 2) Raw 테이블 셀 내 []( 자동 채움 + | -> \| 이스케이프
    const afterTableText = getRawEditorText(rawEl)
    const pipeTargetAt = afterTableText.indexOf('[buildTree](#buildtree)')
    act(() => {
      rawView.dispatch({
        changes: { from: pipeTargetAt, to: pipeTargetAt + '[buildTree](#buildtree)'.length, insert: '[](' },
        selection: { anchor: pipeTargetAt + 3 }
      })
    })
    const rawTableListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    await user.click(within(rawTableListbox).getByRole('option', { name: /A \| B 표기/ }))
    expect(getRawEditorText(rawEl)).toContain('| target | [A \\| B 표기](#a-b-표기) |')

    // 3) Raw 본문 [`심볼`]( 완성
    const bodyEnd = getRawEditorText(rawEl).length
    act(() => {
      rawView.dispatch({
        changes: { from: bodyEnd, to: bodyEnd, insert: '[`buildTree`](' },
        selection: { anchor: bodyEnd + '[`buildTree`]('.length }
      })
    })
    await screen.findByRole('listbox', { name: '링크 자동완성' })
    fireEvent.keyDown(rawEl, { key: 'Tab' })
    expect(getRawEditorText(rawEl)).toContain('본문 [`buildTree`](#buildtree)')

    // 4) 위지윅 모드로 전환하여 본문/테이블 []( 자동 채움 및 후속 입력 링크 마크 이탈 확인
    await user.click(screen.getByRole('button', { name: '위지윅' }))
    const wysiwygEl = await screen.findByTestId('document-editor')
    const tableCellP = wysiwygEl.querySelectorAll('td p')[1]
    wysiwygEl.focus()
    const range = document.createRange()
    range.selectNodeContents(tableCellP)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    await user.keyboard(' [[](')
    const wysiwygListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(wysiwygListbox).getAllByRole('option')[0]).toHaveTextContent('개요')
    fireEvent.keyDown(wysiwygEl, { key: 'Enter' })

    await user.keyboard(' 이후')
    expect(wysiwygEl.querySelector('td a[href="#11-개요"]')).toHaveTextContent('개요')

    // 5) Preview 헤딩 id / 문서 목차와 동일한 슬러그 일치 검증
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => {
      expect(document.getElementById('11-개요')).not.toBeNull()
      expect(document.getElementById('buildtree')).not.toBeNull()
      expect(document.getElementById('a-b-표기')).not.toBeNull()
    })
    const tocRegion = screen.getByRole('complementary', { name: '우측 사이드바' })
    expect(within(tocRegion).getByRole('button', { name: /개요/ })).toBeInTheDocument()
  })

  it('handles Ctrl+K wrapping/unwrapping, mutual exclusion with slash menu, modal/dialog blocking, and config.json exclusion', async () => {
    const user = userEvent.setup()
    const md = '# 개요\n\n단일선택 대상\n\n[기존](#개요) 끝'
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'guide.md': md,
            'notes.txt': 'plain text'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))

    const rawEl = await screen.findByTestId('document-editor')
    const selStart = md.indexOf('단일선택')
    setRawEditorSelection(rawEl, selStart, selStart + '단일선택'.length)
    fireEvent.keyDown(rawEl, { key: 'k', ctrlKey: true })

    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    expect(getRawEditorText(rawEl)).toContain('[단일선택](')

    // 슬래시 명령어 메뉴와 동시 열림 방지
    fireEvent.keyDown(rawEl, { key: 'Escape' })
    const rawView = getRawEditorView(rawEl)
    const endNow = getRawEditorText(rawEl).length
    act(() => {
      rawView.dispatch({
        changes: { from: endNow, to: endNow, insert: '\n/' },
        selection: { anchor: endNow + 2 }
      })
    })
    expect(await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })).toBeInTheDocument()

    fireEvent.keyDown(rawEl, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    expect(
      screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })
    ).not.toBeInTheDocument()
    fireEvent.keyDown(rawEl, { key: 'Escape' })

    // 위지윅에서 기존 링크 내부 커서 Ctrl+K -> 언랩 및 메뉴 오픈
    await user.click(screen.getByRole('button', { name: '위지윅' }))
    const wysiwygEl = await screen.findByTestId('document-editor')
    const existingAnchor = wysiwygEl.querySelector('a[href="#개요"]')!
    wysiwygEl.focus()
    const range = document.createRange()
    range.setStart(existingAnchor.firstChild!, 1)
    range.setEnd(existingAnchor.firstChild!, 1)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(wysiwygEl, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    expect(wysiwygEl.textContent).toContain('[기존](')
    fireEvent.keyDown(wysiwygEl, { key: 'Escape' })

    // 전역 설정 패널 모달 열림 중 Ctrl+K 무효
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const settingsDialog = await screen.findByRole('dialog', { name: '전역 설정 패널' })
    fireEvent.keyDown(wysiwygEl, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    // config.json 직접 열기 -> 비마크다운 문서에서는 링크 자동완성/Ctrl+K 비활성
    await user.click(within(settingsDialog).getByRole('button', { name: /설정 파일 직접 열기/i }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
    })
    const configEditor = await screen.findByTestId('document-editor')
    fireEvent.keyDown(configEditor, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    // .txt 비마크다운 문서에서도 [텍스트]( 및 Ctrl+K 비활성
    await user.click(await within(explorer).findByText('notes.txt'))
    const txtEditor = await screen.findByTestId('document-editor')
    const txtView = getRawEditorView(txtEditor)
    act(() => {
      txtView.dispatch({ changes: { from: 10, to: 10, insert: ' [a](' }, selection: { anchor: 15 } })
    })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
    fireEvent.keyDown(txtEditor, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    // 마크다운 문서(guide.md) 탭 복귀 후 dirty 탭 닫기 확인 다이얼로그 열림 중 Ctrl+K 무효
    await user.click(screen.getByRole('tab', { name: /guide\.md/ }))
    const activeMdEditor = await screen.findByTestId('document-editor')
    await user.click(screen.getByRole('button', { name: 'guide.md 탭 닫기' }))
    const confirmDialog = await screen.findByRole('alertdialog')
    expect(confirmDialog).toBeInTheDocument()
    fireEvent.keyDown(activeMdEditor, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
  })

  it('surfaces nested workspace markdown files in Raw and WYSIWYG link autocomplete without expanding collapsed folders, excluding active doc and encoding relative hrefs', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, readDirCalls } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'docs/active.md': '# 현재 개요\n\n',
            'docs/sub/api (1).md': '# API 1',
            'guides/setup.markdown': '# Setup',
            'notes.txt': 'ignored',
            '.git/secret.md': 'ignored'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    expect(readDirCalls).toEqual(['C:/wiki'])
    await user.click(await within(explorer).findByText('docs'))
    await user.click(await within(explorer).findByText('active.md'))

    const rawEl = await screen.findByTestId('document-editor')
    appendRawEditorText(rawEl, '[](')

    const listbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(listbox).queryByText('active.md')).not.toBeInTheDocument()
    expect(within(listbox).queryByText('notes.txt')).not.toBeInTheDocument()
    expect(within(listbox).queryByText('secret.md')).not.toBeInTheDocument()
    expect(within(listbox).getByText('docs/sub/api (1).md')).toBeInTheDocument()
    expect(within(listbox).getByText('guides/setup.markdown')).toBeInTheDocument()

    // Collapsed folders ('docs/sub', 'guides') must NOT be expanded via readDir
    expect(readDirCalls).toEqual(['C:/wiki', 'C:/wiki/docs'])

    appendRawEditorText(rawEl, './')
    await waitFor(() => {
      const updated = screen.getByRole('listbox', { name: '링크 자동완성' })
      expect(within(updated).queryByText('guides/setup.markdown')).not.toBeInTheDocument()
      expect(within(updated).getByText('docs/sub/api (1).md')).toBeInTheDocument()
    })
    await user.click(within(screen.getByRole('listbox', { name: '링크 자동완성' })).getByRole('option'))
    expect(getRawEditorText(rawEl)).toContain('[api (1)](./sub/api%20%281%29.md)')

    // Switch to 위지윅 and insert a parent-relative ../ link
    await user.click(screen.getByRole('button', { name: '위지윅' }))
    const wysiwygEl = await screen.findByTestId('document-editor')
    expect(wysiwygEl.querySelector('a[href="./sub/api%20%281%29.md"]')).not.toBeNull()

    const paragraphs = wysiwygEl.querySelectorAll('p')
    const lastP = paragraphs[paragraphs.length - 1]!
    const range = document.createRange()
    range.selectNodeContents(lastP)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    wysiwygEl.focus()
    document.dispatchEvent(new Event('selectionchange'))

    await user.keyboard(' [[셋업](../')
    const wListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(wListbox).queryByText('docs/sub/api (1).md')).not.toBeInTheDocument()
    await user.click(within(wListbox).getByRole('option', { name: /setup\.markdown/ }))

    await user.click(screen.getByRole('button', { name: 'Raw' }))
    expect(getRawEditorText(await screen.findByTestId('document-editor'))).toContain(
      '[셋업](../guides/setup.markdown)'
    )
    expect(readDirCalls).toEqual(['C:/wiki', 'C:/wiki/docs'])
  })

  it('keeps workspace file link candidates synchronized across file creation, collapsed folder rename, file deletion, and workspace:changed events', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'root.md': '# Root\n\n',
            'guides/start.md': '# Start',
            'guides/extra.md': '# Extra'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('왼쪽 사이드바')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(explorer).findByText('root.md'))
    await screen.findByTestId('document-editor')

    // Create a new file via Explorer -> synced into autocomplete
    await user.click(within(sidebar).getByRole('button', { name: /새 파일/i }))
    await user.type(await within(sidebar).findByLabelText('새 파일 이름'), 'draft.md{Enter}')
    await waitFor(() => {
      expect(within(explorer).getByText('draft.md')).toBeInTheDocument()
    })

    // Return to root.md tab so root.md is active
    await user.click(screen.getByRole('tab', { name: /root\.md/ }))
    const rootRawEl = await screen.findByTestId('document-editor')
    appendRawEditorText(rootRawEl, '[](')
    const afterCreateMenu = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(afterCreateMenu).getByRole('option', { name: /draft\.md/ })).toBeInTheDocument()
    expect(within(afterCreateMenu).getByText('guides/start.md')).toBeInTheDocument()
    fireEvent.keyDown(rootRawEl, { key: 'Escape' })

    // Rename collapsed folder 'guides' -> 'manuals' via F2
    const guidesItem = within(sidebar).getByRole('treeitem', { name: 'guides' })
    guidesItem.focus()
    fireEvent.keyDown(guidesItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'manuals{Enter}')
    await waitFor(() => {
      expect(within(explorer).getByText('manuals')).toBeInTheDocument()
    })

    fireEvent.keyDown(rootRawEl, { key: 'k', ctrlKey: true })
    const afterRenameMenu = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(afterRenameMenu).queryByText('guides/start.md')).not.toBeInTheDocument()
    expect(within(afterRenameMenu).getByText('manuals/start.md')).toBeInTheDocument()
    expect(within(afterRenameMenu).getByText('manuals/extra.md')).toBeInTheDocument()
    fireEvent.keyDown(rootRawEl, { key: 'Escape' })

    // Expand 'manuals' and delete 'extra.md' -> removed from autocomplete
    await user.click(within(explorer).getByText('manuals'))
    const extraEl = await within(explorer).findByText('extra.md')
    fireEvent.contextMenu(extraEl)
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /삭제/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i }))
    await waitFor(() => {
      expect(within(explorer).queryByText('extra.md')).not.toBeInTheDocument()
    })

    // Open menu then simulate external file creation + workspace:changed while menu is open
    fireEvent.keyDown(rootRawEl, { key: 'k', ctrlKey: true })
    const beforeWatchMenu = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(beforeWatchMenu).queryByText('manuals/extra.md')).not.toBeInTheDocument()

    await api.workspace.createEntry('C:/wiki', 'watched-doc.md', 'file', '# Watch')
    act(() => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki',
        eventType: 'rename',
        relativePath: 'watched-doc.md'
      })
    })

    await waitFor(() => {
      const refreshedMenu = screen.getByRole('listbox', { name: '링크 자동완성' })
      expect(within(refreshedMenu).getByRole('option', { name: /watched-doc\.md/ })).toBeInTheDocument()
    })
  })

  it('completes workspace switching even when a concurrent workspace:changed refresh arrives while initial markdown files are loading', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki-a',
        workspaces: {
          'C:/wiki-a': {
            'alpha.md': '# Alpha\n\n'
          },
          'C:/wiki-b': {
            'beta.md': '# Beta\n\n',
            'nested/target.md': '# Target'
          }
        }
      }
    )

    const baseListMarkdownFiles = api.workspace.listMarkdownFiles.bind(api.workspace)
    let resolveDelayedList!: (entries: WorkspaceEntry[]) => void
    const delayedListPromise = new Promise<WorkspaceEntry[]>((resolve) => {
      resolveDelayedList = resolve
    })
    let listCallCount = 0
    vi.spyOn(api.workspace, 'listMarkdownFiles').mockImplementation(async () => {
      listCallCount += 1
      if (listCallCount === 2) {
        return await delayedListPromise
      }
      if (listCallCount === 3) {
        return [
          {
            name: 'alpha.md',
            path: 'C:/wiki-a/alpha.md',
            relativePath: 'alpha.md',
            kind: 'file'
          }
        ]
      }
      return await baseListMarkdownFiles()
    })
    vi.spyOn(api.workspace, 'selectFolder')
      .mockResolvedValueOnce('C:/wiki-a')
      .mockResolvedValueOnce('C:/wiki-b')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('alpha.md'))
    await screen.findByTestId('document-editor')

    act(() => {
      emitMenuCommand('open-folder')
    })
    await waitFor(() => {
      expect(listCallCount).toBe(2)
    })

    // Fire a stale workspace:changed event from C:/wiki-a while openWorkspace is awaiting listMarkdownFiles()
    act(() => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki-a',
        eventType: 'rename',
        relativePath: 'alpha.md'
      })
    })
    await waitFor(() => {
      expect(listCallCount).toBe(3)
    })

    const wikiBEntries = await baseListMarkdownFiles()
    await act(async () => {
      resolveDelayedList(wikiBEntries)
    })

    expect(await within(explorer).findByText('beta.md')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /alpha\.md/ })).not.toBeInTheDocument()
    await user.click(within(explorer).getByText('beta.md'))
    const rawEl = await screen.findByTestId('document-editor')
    appendRawEditorText(rawEl, '[](')

    const listbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(listbox).queryAllByText('alpha.md')).toHaveLength(0)
    expect(within(listbox).getByText('nested/target.md')).toBeInTheDocument()
  })
})

describe('Markdown link navigation and missing target banner', () => {
  it('navigates same-doc sections across Preview/Raw/WYSIWYG modes, ignores external URLs, and opens relative links with optional #slug in clicked split pane', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false, showHeadingNumbers: false },
      {
        selectedFolder: 'C:/wiki-nav',
        workspaces: {
          'C:/wiki-nav': {
            'docs/current.md': [
              '# 개요',
              '',
              '- [세부 이동](#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9)',
              '- [외부](https://example.com)',
              '- [메일](mailto:wiki@example.com)',
              '- [가이드](../sub/guide%20%281%29.md#%EC%84%A4%EC%A0%95)',
              '- [형제](./sibling.md)',
              '',
              '본문 첫 줄',
              '',
              '## 세부 항목',
              '',
              '세부 본문'
            ].join('\n'),
            'docs/sibling.md': '# 형제 문서\n\n[현재 복귀](./current.md#개요)',
            'sub/guide (1).md': '# 가이드 시작\n\n안내 본문\n\n## 설정\n\n설정 값'
          }
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    const scrollIntoViewMock = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock
    })

    try {
      window.wikiApi = api
      render(<App />)

      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = screen.getByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('docs'))
      await user.click(await within(explorer).findByText('current.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      expect(within(primaryPane).getByRole('tab', { name: /current\.md/i })).toBeInTheDocument()

      // 1) Preview normal click: same-doc percent-encoded Korean #slug + external links no-op
      await user.click(within(primaryPane).getByRole('button', { name: 'Preview' }))
      scrollIntoViewMock.mockClear()
      fireEvent.click(within(primaryPane).getByRole('link', { name: '세부 이동' }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect((scrollIntoViewMock.mock.instances[0] as HTMLElement).id).toBe('세부-항목')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      const readCallsBeforeExternal = readFileSpy.mock.calls.length
      expect(fireEvent.click(within(primaryPane).getByRole('link', { name: '외부' }))).toBe(false)
      expect(fireEvent.click(within(primaryPane).getByRole('link', { name: '메일' }))).toBe(false)
      expect(readFileSpy).toHaveBeenCalledTimes(readCallsBeforeExternal)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      // 2) Raw mode: normal click does not jump, Ctrl+click jumps cursor to heading line
      await user.click(within(primaryPane).getByRole('button', { name: 'Raw' }))
      const rawCmContent = within(primaryPane).getByTestId('document-editor') as HTMLElement
      const rawView = EditorView.findFromDOM(rawCmContent)!
      const headingOffset = rawView.state.doc.toString().indexOf('## 세부 항목')
      const sectionSpan = Array.from(rawCmContent.querySelectorAll('span')).find((el) =>
        el.textContent?.includes('#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9')
      )!
      const externalSpan = Array.from(rawCmContent.querySelectorAll('span')).find((el) =>
        el.textContent?.includes('https://example.com')
      )!

      fireEvent.click(sectionSpan)
      expect(rawView.state.selection.main.head).not.toBe(headingOffset)

      fireEvent.click(sectionSpan, { ctrlKey: true })
      await waitFor(() => {
        expect(rawView.state.selection.main.head).toBe(headingOffset)
      })
      fireEvent.click(externalSpan, { ctrlKey: true })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      // 3) WYSIWYG mode: normal click does not jump, Meta+click scrolls heading
      await user.click(within(primaryPane).getByRole('button', { name: '위지윅' }))
      scrollIntoViewMock.mockClear()
      const wysiwygEl = within(primaryPane).getByTestId('document-editor')
      const wysiwygSectionLink = Array.from(wysiwygEl.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === '#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9'
      )!
      expect(fireEvent.click(wysiwygSectionLink)).toBe(false)
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      expect(fireEvent.click(wysiwygSectionLink, { metaKey: true })).toBe(false)
      await waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      })
      expect((scrollIntoViewMock.mock.instances[0] as HTMLElement).textContent).toContain('세부 항목')

      // 4) Preview relative file link with percent encoding + #slug opens tab and jumps to target heading
      await user.click(within(primaryPane).getByRole('button', { name: 'Preview' }))
      await user.click(within(primaryPane).getByRole('link', { name: '가이드' }))
      const guideTab = await within(primaryPane).findByRole('tab', { name: /guide \(1\)\.md/i })
      expect(guideTab).toHaveAttribute('aria-selected', 'true')
      await waitFor(() => {
        const targetCm = within(primaryPane).getByTestId('document-editor') as HTMLElement
        const targetView = EditorView.findFromDOM(targetCm)!
        expect(targetView.state.selection.main.head).toBe(
          targetView.state.doc.toString().indexOf('## 설정')
        )
      })

      // 5) Split mode: relative click in secondary pane opens/activates tab ONLY in secondary pane
      fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /current\.md/i }))
      const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
      await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

      const secondaryPane = screen.getByTestId('pane-secondary')
      await user.click(within(secondaryPane).getByRole('button', { name: 'Preview' }))
      await user.click(within(secondaryPane).getByRole('link', { name: '형제' }))

      const siblingTab = await within(secondaryPane).findByRole('tab', { name: /sibling\.md/i })
      expect(siblingTab).toHaveAttribute('aria-selected', 'true')
      expect(within(primaryPane).queryByRole('tab', { name: /sibling\.md/i })).not.toBeInTheDocument()
      expect(within(secondaryPane).getAllByRole('tab')).toHaveLength(2)

      // Activating already-open current.md tab in secondary pane via ./current.md#개요 keeps tab count at 2 and scrolls
      await user.click(within(secondaryPane).getByRole('button', { name: 'Preview' }))
      scrollIntoViewMock.mockClear()
      await user.click(within(secondaryPane).getByRole('link', { name: '현재 복귀' }))
      await waitFor(() => {
        expect(within(secondaryPane).getByRole('tab', { name: /current\.md/i })).toHaveAttribute(
          'aria-selected',
          'true'
        )
      })
      expect(within(secondaryPane).getAllByRole('tab')).toHaveLength(2)
      await waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      })
      expect((scrollIntoViewMock.mock.instances[0] as HTMLElement).id).toBe('개요')
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: originalScrollIntoView
      })
    }
  })

  it('displays error banner without creating files for missing targets or workspace escapes, and opens target file even when its #slug is missing', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki-broken',
        workspaces: {
          'C:/wiki-broken': {
            'docs/index.md': [
              '# 인덱스',
              '',
              '- [없는 섹션](#no-such-heading)',
              '- [없는 파일](./missing.md)',
              '- [루트 밖](../../outside.md)',
              '- [파일은 있음](./target.md#missing-sec)'
            ].join('\n'),
            'docs/target.md': '# 존재하는 제목\n\n내용'
          }
        }
      }
    )
    const createEntrySpy = vi.spyOn(api.workspace, 'createEntry')
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('docs'))
    await user.click(await within(explorer).findByText('index.md'))

    const initialSnapshot = getFilesSnapshot()
    const primaryPane = screen.getByTestId('pane-primary')
    await user.click(within(primaryPane).getByRole('button', { name: 'Preview' }))

    // 1) Missing #slug in current document
    await user.click(within(primaryPane).getByRole('link', { name: '없는 섹션' }))
    const missingHeadingAlert = await screen.findByRole('alert')
    expect(missingHeadingAlert).toHaveTextContent(/찾을 수 없습니다/)

    // 2) Missing relative markdown file
    await user.click(within(primaryPane).getByRole('link', { name: '없는 파일' }))
    const missingFileAlert = await screen.findByRole('alert')
    expect(missingFileAlert).toHaveTextContent(/찾을 수 없습니다/)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
    expect(createEntrySpy).not.toHaveBeenCalled()
    expect(within(primaryPane).getByRole('tab', { name: /index\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // 3) Path outside workspace root
    const readCallsBeforeEscape = readFileSpy.mock.calls.length
    await user.click(within(primaryPane).getByRole('link', { name: '루트 밖' }))
    const outsideAlert = await screen.findByRole('alert')
    expect(outsideAlert).toHaveTextContent(/워크스페이스 루트 밖/)
    expect(readFileSpy).toHaveBeenCalledTimes(readCallsBeforeEscape)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
    expect(createEntrySpy).not.toHaveBeenCalled()

    // 4) Existing target file + missing #slug opens target tab AND shows error banner
    await user.click(within(primaryPane).getByRole('link', { name: '파일은 있음' }))
    const targetTab = await within(primaryPane).findByRole('tab', { name: /target\.md/i })
    expect(targetTab).toHaveAttribute('aria-selected', 'true')
    const missingTargetSlugAlert = await screen.findByRole('alert')
    expect(missingTargetSlugAlert).toHaveTextContent(/missing-sec/)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
  })
})
