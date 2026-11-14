import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AppConfig,
  cloneAppConfig,
  DEFAULT_APP_CONFIG,
  validateConfigRaw
} from '@shared/config'
import type { WikiApi } from '@shared/ipc'
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
import { App } from './App'

interface VirtualFsOptions {
  workspaces?: Record<string, Record<string, string | null>>
  selectedFolder?: string | null
}

function normalizePosix(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
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
  getListenerCount: () => number
  getFilesSnapshot: () => Map<string, string>
  readDirCalls: string[]
} {
  let state: AppConfig = {
    ...cloneAppConfig(DEFAULT_APP_CONFIG),
    ...initialOverrides
  }
  const configListeners = new Set<(config: AppConfig) => void>()
  const workspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
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
      async getRoot() {
        return activeRoot
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
    }
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
    getListenerCount: () => configListeners.size,
    getFilesSnapshot: () => new Map(files),
    readDirCalls
  }
}

describe('App shell, theme persistence, and settings panel', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('initializes document theme from persisted config on mount', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'dark' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })

  it('toggles theme from header, updates data-theme immediately, and persists across restart', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    const firstMount = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const headerToggle = await screen.findByRole('button', { name: /테마 전환/i })
    await user.click(headerToggle)

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
    const { api } = createInMemoryWikiApi({ theme: 'light', autoSave: true })
    window.wikiApi = api

    render(<App />)

    const settingsButton = await screen.findByRole('button', { name: /설정/i })
    await user.click(settingsButton)

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

    const editor = (await screen.findByTestId('document-editor')) as HTMLTextAreaElement
    expect(editor.value).toContain('"theme": "dark"')
    expect(editor.value).toContain('"autoSave": true')
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
    const { api, emitExternalChange } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const editor = (await screen.findByTestId('document-editor')) as HTMLTextAreaElement
    expect(editor.value).toContain('"theme": "light"')

    emitExternalChange({ theme: 'dark' })

    await waitFor(() => {
      expect((screen.getByTestId('document-editor') as HTMLTextAreaElement).value).toContain(
        '"theme": "dark"'
      )
    })
  })

  it('rolls back theme and shows an error banner when saving theme fails', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    api.config.update = async () => {
      throw new Error('디스크 쓰기 오류')
    }
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    await user.click(await screen.findByRole('button', { name: /테마 전환/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('디스크 쓰기 오류')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('keeps the latest theme when rapid toggles resolve out of order', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })

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
    const toggle = await screen.findByRole('button', { name: /테마 전환/i })

    await user.click(toggle)
    await user.click(toggle)

    resolveFirst({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })
  })

  it('shows an error banner when reading raw config fails', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    api.config.readRaw = async () => {
      throw new Error('읽기 권한 없음')
    }
    window.wikiApi = api

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('읽기 권한 없음')
  })

  it('closes the settings panel when clicking 닫기 and surfaces initial load failures', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    const view = render(<App />)

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    expect(screen.getByLabelText('전역 설정 패널')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /닫기/i }))
    expect(screen.queryByLabelText('전역 설정 패널')).not.toBeInTheDocument()

    view.unmount()

    const failingApi = createInMemoryWikiApi().api
    failingApi.config.get = async () => {
      throw new Error('초기 설정 로드 실패')
    }
    window.wikiApi = failingApi

    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('초기 설정 로드 실패')
    await user.click(screen.getByRole('button', { name: /설정/i }))
    expect(
      await screen.findByText('C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json')
    ).toBeInTheDocument()
  })

  it('keeps error banner visible and avoids stale raw read when saving theme fails while config editor is open', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
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

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))
    await screen.findByTestId('document-editor')
    const callsBeforeToggle = readRawCalls

    await user.click(screen.getByRole('button', { name: /테마 전환/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패 유지 테스트')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(readRawCalls).toBe(callsBeforeToggle)
  })

  it('surfaces error and avoids flicker when onChanged from first toggle arrives during second failing toggle', async () => {
    const user = userEvent.setup()
    const { api, emitExternalChange } = createInMemoryWikiApi({ theme: 'light' })

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
    const toggle = await screen.findByRole('button', { name: /테마 전환/i })

    await user.click(toggle)
    await user.click(toggle)

    emitExternalChange({ theme: 'dark' })
    resolveFirst({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    rejectSecond(new Error('두 번째 저장 실패'))

    expect(await screen.findByRole('alert')).toHaveTextContent('두 번째 저장 실패')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('applies persisted config if an early toggle fails before initial get() resolves', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'dark' })

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

    await user.click(await screen.findByRole('button', { name: /테마 전환/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('초기 로드 전 저장 실패')

    resolveGet({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })
})

describe('Workspace folder tree, favorites, editing, and saving', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('opens a workspace folder via dialog, lazily loads 1-depth subfolders on click, and collapses cleanly', async () => {
    const user = userEvent.setup()
    const { api, readDirCalls } = createInMemoryWikiApi(
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

    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))

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
    const { api, getFilesSnapshot } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))

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

  it('toggles current workspace in favorites and switches workspaces in one click from launcher dropdown', async () => {
    const user = userEvent.setup()
    const favoriteBeta = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const { api } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('alpha.md')).toBeInTheDocument()

    // Add alpha to favorites
    const favToggle = within(sidebar).getByRole('button', { name: /즐겨찾기 추가/i })
    await user.click(favToggle)
    await waitFor(() => {
      expect(within(sidebar).getByRole('button', { name: /즐겨찾기 해제/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    })

    // Open launcher dropdown and switch to beta in one click
    await user.click(screen.getByRole('button', { name: /워크스페이스 전환/i }))
    const launcherMenu = await screen.findByRole('region', { name: /워크스페이스 목록/i })
    await user.click(within(launcherMenu).getByRole('button', { name: /★\s*beta/i }))

    expect(await within(sidebar).findByText('beta.md')).toBeInTheDocument()
    expect(within(sidebar).queryByText('alpha.md')).not.toBeInTheDocument()

    // Remove beta from favorites via launcher dropdown button
    await user.click(screen.getByRole('button', { name: /워크스페이스 전환/i }))
    const updatedMenu = await screen.findByRole('region', { name: /워크스페이스 목록/i })
    await user.click(within(updatedMenu).getByRole('button', { name: 'beta 즐겨찾기 해제' }))

    await waitFor(() => {
      expect(within(sidebar).getByRole('button', { name: /즐겨찾기 추가/i })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    })
  })

  it('tracks dirty ● indicator, saves manually with Ctrl+S, and auto-saves when autoSave is enabled', async () => {
    const user = userEvent.setup()
    const { api, getFilesSnapshot } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('note.md'))

    const editor = (await screen.findByTestId('document-editor')) as HTMLTextAreaElement
    expect(editor.value).toBe('# Initial')
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    // Edit content -> dirty ● appears
    await user.type(editor, '\nUpdated line')
    expect(screen.getByTestId('dirty-indicator')).toHaveTextContent('●')

    // Ctrl+S saves and clears dirty ●
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/docs/note.md')).toBe('# Initial\nUpdated line')

    // Enable auto-save in settings panel
    await user.click(screen.getByRole('button', { name: /설정/i }))
    const autoSaveToggle = await screen.findByRole('checkbox', { name: /자동 저장/i })
    await user.click(autoSaveToggle)
    await waitFor(() => {
      expect(autoSaveToggle).toBeChecked()
    })

    // Type again and wait for debounced auto-save
    await user.type(editor, '\nAuto saved')
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
    const { api } = createInMemoryWikiApi({ theme: 'light', autoSave: false })
    window.wikiApi = api

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const editor = (await screen.findByTestId('document-editor')) as HTMLTextAreaElement
    expect(editor.value).toContain('"theme": "light"')

    // Invalid JSON must be rejected and keep dirty indicator
    fireEvent.change(editor, { target: { value: '{ broken json' } })
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
    fireEvent.change(editor, { target: { value: nextConfigJson } })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect((await api.config.get()).autoSave).toBe(true)
  })

  it('prompts before leaving unsaved edits, syncs active document path on rename, and refreshes on workspace watch events', async () => {
    const user = userEvent.setup()
    const { api, emitWorkspaceChange, getFilesSnapshot } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('first.md'))
    const editor = (await screen.findByTestId('document-editor')) as HTMLTextAreaElement
    await user.type(editor, ' edited')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Clicking second.md while dirty opens confirmation dialog -> choose 저장 후 이동
    await user.click(within(sidebar).getByText('second.md'))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 이동/i }))

    await waitFor(() => {
      expect((screen.getByTestId('document-editor') as HTMLTextAreaElement).value).toBe('# Second')
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
    await user.type(screen.getByTestId('document-editor'), '!')
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
})
