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

    // Clicking second.md opens a second tab while first.md stays open and dirty; closing first.md prompts -> 저장 후 닫기
    await user.click(within(sidebar).getByText('second.md'))
    expect((screen.getByTestId('document-editor') as HTMLTextAreaElement).value).toBe('# Second')
    await user.click(screen.getByRole('button', { name: 'first.md 탭 닫기' }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 닫기/i }))

    await waitFor(() => {
      expect((screen.getByTestId('document-editor') as HTMLTextAreaElement).value).toBe('# Second')
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

  it('allows returning selection to workspace root, disables auto-save on config.json and paused dirty dialogs, and blocks concurrent Ctrl+S saves', async () => {
    const user = userEvent.setup()
    let writeCount = 0
    let resolveWrite!: () => void
    const { api } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
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
    await user.type(editor, 'hello')
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    expect(writeCount).toBe(1)
    resolveWrite()
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })

    // While dirty-confirmation dialog is open, auto-save is paused and must not auto-write before choice
    await user.type(editor, ' unsaved')
    await user.click(screen.getByRole('button', { name: 'top-level.md 탭 닫기' }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(writeCount).toBe(1)
    await user.click(within(dirtyDialog).getByRole('button', { name: /버리고 닫기/i }))
    await user.click(within(sidebar).getByText('other.md'))
    await waitFor(() => {
      expect((screen.getByTestId('document-editor') as HTMLTextAreaElement).value).toBe('# Other')
    })

    // Auto-save must NOT fire on invalid mid-edit config.json
    await user.click(screen.getByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))
    const configEditor = await screen.findByTestId('document-editor')
    fireEvent.change(configEditor, { target: { value: '{ invalid json' } })
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
    const { api, getFilesSnapshot } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('a.md'))
    const editor = await screen.findByTestId('document-editor')
    await user.type(editor, ' v1')

    // Wait for auto-save to enter in-flight state
    await waitFor(() => expect(callNum).toBe(1))
    // Type more while first save is still in flight, then switch workspace and choose 저장 후 이동
    await user.type(editor, ' v2')
    await user.click(screen.getByRole('button', { name: /워크스페이스 전환/i }))
    const launcherMenu = await screen.findByRole('region', { name: /워크스페이스 목록/i })
    await user.click(within(launcherMenu).getByRole('button', { name: /★\s*inflight-next/i }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 이동/i }))

    releaseFirstSave()
    expect(await within(sidebar).findByText('next.md')).toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/inflight/a.md')).toBe('# A v1 v2')
  })
})

describe('Multi-tab and 2-pane Split View layout', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('opens multiple tabs, switches tabs, closes via X and middle-click, and prompts before closing the last tab of a dirty buffer', async () => {
    const user = userEvent.setup()
    const { api, getFilesSnapshot } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
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
    await user.type(within(primaryPane).getByTestId('document-editor'), ' edited')
    expect(within(tabs[2]).getByTestId('tab-dirty-indicator')).toHaveTextContent('●')

    // Click one.md tab to switch cleanly without losing three.md edits
    await user.click(tabs[0])
    expect(within(primaryPane).getByRole('tab', { name: /one\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect((within(primaryPane).getByTestId('document-editor') as HTMLTextAreaElement).value).toBe(
      '# One'
    )

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
    const { api, getFilesSnapshot } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
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
    const primaryEditor = within(primaryPane).getByTestId('document-editor') as HTMLTextAreaElement
    const secondaryEditor = within(secondaryPane).getByTestId('document-editor') as HTMLTextAreaElement
    await user.type(primaryEditor, ' synced!')

    expect(secondaryEditor.value).toBe('# Shared synced!')
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

    // Switch split direction to vertical and resize splitter via keyboard and pointer drag
    await user.click(screen.getByRole('button', { name: '상하 분할' }))
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
    const { api } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
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

    // Drag b.md onto split drop zone in single mode -> creates secondary split with b.md
    const bTab = within(primaryPane).getByRole('tab', { name: /b\.md/i })
    fireEvent.dragStart(bTab)
    const splitDropZone = await screen.findByTestId('split-drop-zone-secondary')
    fireEvent.drop(splitDropZone)

    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /b\.md/i })).not.toBeInTheDocument()
  })

  it('keeps at most 2 editor instances mounted when 25+ tabs are open and restores cursor/scroll on tab switch', async () => {
    const user = userEvent.setup()
    const files: Record<string, string> = {}
    for (let i = 1; i <= 25; i += 1) {
      const num = String(i).padStart(2, '0')
      files[`doc-${num}.md`] = `# Document ${num}\nLine 2 content for testing cursor and scroll`
    }

    const { api } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
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
    const editor01 = within(primaryPane).getByTestId('document-editor') as HTMLTextAreaElement
    editor01.setSelectionRange(4, 11)
    fireEvent.select(editor01)
    editor01.scrollTop = 180
    fireEvent.scroll(editor01)

    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-02.md' }))
    expect(screen.getAllByTestId('document-editor')).toHaveLength(1)
    expect((within(primaryPane).getByTestId('document-editor') as HTMLTextAreaElement).value).toContain(
      '# Document 02'
    )

    // Switch back to doc-01.md -> restored cursor & scrollTop
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-01.md' }))
    const restored01 = within(primaryPane).getByTestId('document-editor') as HTMLTextAreaElement
    expect(restored01.selectionStart).toBe(4)
    expect(restored01.selectionEnd).toBe(11)
    expect(restored01.scrollTop).toBe(180)

    // Move doc-25.md to secondary pane -> still at most 2 editor DOM instances across 25 tabs
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: 'doc-25.md' }))
    const menu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(menu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(screen.getAllByTestId('document-editor')).toHaveLength(2)
  })

  it('syncs file renames and deletions across split panes and keeps config.json tab open across workspace switches', async () => {
    const user = userEvent.setup()
    const nextFav = addFavoriteWorkspace([], 'C:/wiki/ws2', 'ws2', '2026-11-14T00:00:00.000Z')
    const { api } = createInMemoryWikiApi(
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
    await user.click(await screen.findByRole('button', { name: /폴더 열기/i }))
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('target.md'))
    await user.click(within(sidebar).getByText('keep.md'))

    // Open config.json as its own tab too
    await user.click(screen.getByRole('button', { name: /설정/i }))
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
    await user.click(screen.getByRole('button', { name: /워크스페이스 전환/i }))
    await user.click(
      within(await screen.findByRole('region', { name: /워크스페이스 목록/i })).getByRole('button', {
        name: /★\s*ws2/i
      })
    )

    expect(await within(sidebar).findByText('ws2.md')).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /keep\.md/i })).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()
  })
})
