import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppConfig, cloneAppConfig, DEFAULT_APP_CONFIG } from '@shared/config'
import {
  createEmptyGitStatus,
  type GitDiffRequest,
  type GitFileStatusCode,
  type GitGraphCommit,
  type GitLogResult
} from '@shared/git'
import type { DiagramSaveRequest, WikiApi, WikiGitApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import {
  addFavoriteWorkspace,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind
} from '@shared/workspace'
import { defaultMermaidRenderer } from './editor/mermaidRenderer'
import {
  buildWikiAssetUrl,
  getImageExtensionForMimeType,
  isSupportedImageFile,
  toMarkdownRelativeImagePath,
  type WorkspaceImageIngestInput,
  type WorkspaceImageIngestResult
} from '@shared/assets'
import { installSvgCanvasStub } from './test/svgCanvasStub'
import { App } from './App'
import themeCss from './styles/theme.css?raw'
import {
  appendRawEditorText,
  createInMemoryWikiApi,
  getRawEditorScroller,
  getRawEditorSelection,
  getRawEditorText,
  getRawEditorView,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

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
      svg: `<svg viewBox="0 0 240 120" width="100%" style="max-width: 240px;" data-mermaid-theme="${activeTheme}" data-code="${text.trim()}"><g><text>DiagramOK</text></g></svg>`
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
    const closeTopLevelBtn = screen.getByRole('button', { name: 'top-level.md 탭 닫기' })
    appendRawEditorText(editor, ' unsaved')
    await user.click(closeTopLevelBtn)
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
  }, 30_000)

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
      expect(blocks[0].querySelector('.mermaid-svg-container svg')?.getAttribute('data-mermaid-theme')).toBe(
        'default'
      )
      expect(within(blocks[1]).getByRole('alert').textContent).toContain('SYNTAX_ERROR broken node')
    })

    // Return to Raw: lossless roundtrip preserves original markdown without dirty flag
    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(diagramDoc)
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
  })

  it('supports Mermaid action bar code copy, keyboard/hover reveal, WYSIWYG single-header placement, syntax-error/blank handling, and failure alerts across Preview, Split, and WYSIWYG modes', async () => {
    const user = userEvent.setup()
    const validSource = 'graph TD\n  SECRET_APP_FLOW --> ServiceB'
    const brokenSource = 'graph TD\n  SYNTAX_ERROR'
    const docContent = [
      '# Mermaid Copy E2E',
      '',
      '```mermaid',
      validSource,
      '```',
      '',
      '```mermaid',
      brokenSource,
      '```',
      '',
      '```mermaid',
      '   ',
      '```'
    ].join('\n')

    const logEntries: RendererLogPayload[] = []
    let shouldFailCopy = false
    const copyText = vi.fn(async () => {
      if (shouldFailCopy) {
        throw new Error('App clipboard failure')
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\mermaid-copy',
        workspaces: {
          'C:\\wiki\\mermaid-copy': {
            'actions.md': docContent
          }
        },
        diagram: { copyText },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            logEntries.push(payload)
          })
        }
      }
    )
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('actions.md'))

      const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })

      // 1. Preview mode: floating bar hover/focus reveal, blank disabled, broken syntax copy allowed, multi-block isolation
      await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
      await waitFor(() => {
        expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      const previewBlocks = screen.getAllByTestId('mermaid-diagram')
      const previewValidToolbar = within(previewBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      const previewValidCopyBtn = within(previewValidToolbar).getByRole('button', { name: '코드 복사' })
      const previewBrokenCopyBtn = within(previewBlocks[1]).getByRole('button', { name: '코드 복사' })
      const previewBlankCopyBtn = within(previewBlocks[2]).getByRole('button', { name: '코드 복사' })

      expect(previewValidToolbar).toHaveClass('is-floating')
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('0')
      expect(previewBlankCopyBtn).toBeDisabled()

      // Hover & focus reveal floating toolbar in Preview
      await user.hover(previewBlocks[0])
      expect(previewValidToolbar).toHaveClass('is-visible')
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('1')
      await user.unhover(previewBlocks[0])
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('0')

      previewValidCopyBtn.focus()
      expect(previewValidCopyBtn).toHaveFocus()
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('1')

      // Click copy on valid block and broken syntax block -> independent feedback
      await user.click(previewValidCopyBtn)
      expect(copyText).toHaveBeenCalledWith(validSource)
      expect(previewValidCopyBtn).toHaveTextContent('복사됨')
      expect(previewBrokenCopyBtn).not.toHaveTextContent('복사됨')

      await user.hover(previewBlocks[1])
      await user.click(previewBrokenCopyBtn)
      expect(copyText).toHaveBeenLastCalledWith(brokenSource)

      // 2. Split mode: right preview pane renders floating action bar and copies source
      await user.click(within(modeGroup).getByRole('button', { name: 'Split' }))
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
      expect(splitBlocks).toHaveLength(3)
      const splitValidToolbar = within(splitBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(splitValidToolbar).toHaveClass('is-floating')
      await user.hover(splitBlocks[0])
      await user.click(within(splitValidToolbar).getByRole('button', { name: '코드 복사' }))
      expect(copyText).toHaveBeenLastCalledWith(validSource)

      // 3. WYSIWYG mode: single integrated header toolbar beside 코드 편집 (zero floating preview toolbar)
      await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
      await waitFor(() => {
        expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
      })
      const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
      const wysiwygValidHeader = wysiwygBlocks[0].querySelector('.mermaid-node-header') as HTMLElement
      const wysiwygValidPreview = wysiwygBlocks[0].querySelector('.mermaid-node-preview') as HTMLElement
      expect(
        within(wysiwygBlocks[0]).getAllByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      ).toHaveLength(1)
      expect(
        within(wysiwygValidHeader).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      ).toHaveClass('is-inline')
      expect(within(wysiwygValidHeader).getByRole('button', { name: '코드 편집' })).toBeInTheDocument()
      expect(
        within(wysiwygValidPreview).queryByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      ).not.toBeInTheDocument()
      expect(within(wysiwygBlocks[2]).getByRole('button', { name: '코드 복사' })).toBeDisabled()

      // Copy failure displays inline role="alert" scoped to that block + sanitized log without raw source
      shouldFailCopy = true
      const wysiwygValidCopyBtn = within(wysiwygValidHeader).getByRole('button', { name: '코드 복사' })
      await user.click(wysiwygValidCopyBtn)
      expect(within(wysiwygBlocks[0]).getByRole('alert')).toHaveTextContent('App clipboard failure')
      const failureLogs = logEntries.filter((entry) => entry.message === 'Mermaid code copy failed')
      expect(failureLogs).toHaveLength(1)
      expect(failureLogs[0]).toMatchObject({
        level: 'error',
        category: 'ui',
        data: { codeLength: validSource.length }
      })
      expect(JSON.stringify(logEntries)).not.toContain('SECRET_APP_FLOW')

      // Retry success with fake timers -> clears alert and reverts check feedback after 1500ms
      shouldFailCopy = false
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(wysiwygValidCopyBtn)
        await Promise.resolve()
      })
      expect(within(wysiwygBlocks[0]).queryByRole('alert')).not.toBeInTheDocument()
      expect(wysiwygValidCopyBtn).toHaveTextContent('복사됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(wysiwygValidCopyBtn).not.toHaveTextContent('복사됨')
      vi.useRealTimers()

      // Return to Raw: lossless roundtrip and clean buffer without dirty flag
      await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
      cleanup()
    }
  })

  it('supports Mermaid 2x theme-backed PNG clipboard copy across Preview, Split (live edit/error/recovery), and WYSIWYG modes with sanitized failure alerts', async () => {
    const user = userEvent.setup()
    const validSource = 'graph TD\n  SECRET_APP_IMG --> ServiceB'
    const brokenSource = 'graph TD\n  SYNTAX_ERROR'
    const docContent = [
      '# Mermaid Image E2E',
      '',
      '```mermaid',
      validSource,
      '```',
      '',
      '```mermaid',
      brokenSource,
      '```',
      '',
      '```mermaid',
      '   ',
      '```'
    ].join('\n')

    const logEntries: RendererLogPayload[] = []
    let shouldFailCopyImage = false
    const copiedPngPayloads: Uint8Array[] = []
    const copyImage = vi.fn(async (bytes: Uint8Array) => {
      copiedPngPayloads.push(bytes)
      if (shouldFailCopyImage) {
        throw new Error('App PNG clipboard failed')
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\mermaid-image-copy',
        workspaces: {
          'C:\\wiki\\mermaid-image-copy': {
            'diagram-export.md': docContent
          }
        },
        diagram: { copyImage },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            logEntries.push(payload)
          })
        }
      }
    )
    window.wikiApi = api

    const canvasStub = installSvgCanvasStub()
    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('diagram-export.md'))

      const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })

      // 1. Preview mode: 이미지 복사 first in toolbar, light #ffffff 2x copy, broken/blank disabled
      await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
      await waitFor(() => {
        expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      const previewBlocks = screen.getAllByTestId('mermaid-diagram')
      const previewValidToolbar = within(previewBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(previewValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])

      const previewValidImageBtn = within(previewValidToolbar).getByRole('button', {
        name: '이미지 복사'
      })
      const previewBrokenImageBtn = within(previewBlocks[1]).getByRole('button', {
        name: '이미지 복사'
      })
      const previewBrokenCodeBtn = within(previewBlocks[1]).getByRole('button', {
        name: '코드 복사'
      })
      const previewBlankImageBtn = within(previewBlocks[2]).getByRole('button', {
        name: '이미지 복사'
      })
      expect(previewValidImageBtn).toBeEnabled()
      expect(previewBrokenImageBtn).toBeDisabled()
      expect(previewBrokenCodeBtn).toBeEnabled()
      expect(previewBlankImageBtn).toBeDisabled()

      await user.hover(previewBlocks[0])
      await user.click(previewValidImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(1)
        expect(previewValidImageBtn).toHaveTextContent('복사됨')
      })
      expect(canvasStub.calls).toHaveLength(1)
      expect(canvasStub.calls[0]).toMatchObject({
        pixelWidth: 544,
        pixelHeight: 304
      })
      expect(canvasStub.calls[0].decodedSvg).toContain('width="272"')
      expect(canvasStub.calls[0].decodedSvg).toContain('height="152"')
      expect(canvasStub.calls[0].decodedSvg).toContain('fill="#ffffff"')
      expect(canvasStub.calls[0].decodedSvg).not.toContain('max-width')
      expect(copiedPngPayloads[0]).toEqual(new Uint8Array([137, 80, 78, 71, 1, 544 & 0xff]))

      // Toggle dark theme in Preview -> exports #161b22 dark background PNG
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'dark')
        expect(previewValidImageBtn).toBeEnabled()
      })
      await user.hover(previewBlocks[0])
      await user.click(previewValidImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(2)
      })
      expect(canvasStub.calls).toHaveLength(2)
      expect(canvasStub.calls[1]).toMatchObject({
        pixelWidth: 544,
        pixelHeight: 304
      })
      expect(canvasStub.calls[1].decodedSvg).toContain('fill="#161b22"')
      expect(copiedPngPayloads[1]).toEqual(new Uint8Array([137, 80, 78, 71, 2, 544 & 0xff]))

      // Restore light theme for subsequent checks
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'default')
        expect(previewValidImageBtn).toBeEnabled()
      })

      // 2. Split mode: image copy works, live edit to SYNTAX_ERROR disables 이미지 복사 while keeping 코드 복사 enabled, and recovery re-enables
      await user.click(within(modeGroup).getByRole('button', { name: 'Split' }))
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      await waitFor(() => {
        expect(within(splitPreview).getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(
          within(within(splitPreview).getAllByTestId('mermaid-diagram')[0]).getByRole('button', {
            name: '이미지 복사'
          })
        ).toBeEnabled()
      })

      const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
      const splitImageBtn = within(splitBlocks[0]).getByRole('button', { name: '이미지 복사' })
      const splitCodeBtn = within(splitBlocks[0]).getByRole('button', { name: '코드 복사' })
      await user.hover(splitBlocks[0])
      await user.click(splitImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(3)
      })

      const splitRawEditor = document.querySelector('.editor-split-region.is-raw') as HTMLElement
      const brokenLiveDoc = docContent.replace(validSource, 'graph TD\n  SYNTAX_ERROR_LIVE')
      setRawEditorText(splitRawEditor, brokenLiveDoc)

      // Immediately during debounce wait and after syntax error banner appears, 이미지 복사 is disabled while 코드 복사 remains active
      expect(splitImageBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()
      await waitFor(() => {
        expect(within(splitBlocks[0]).getByText('Mermaid 문법 오류')).toBeInTheDocument()
      })
      expect(splitImageBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()

      // Recover original valid source -> re-enables 이미지 복사 cleanly without leaving dirty state
      setRawEditorText(splitRawEditor, docContent)
      await waitFor(() => {
        expect(within(splitBlocks[0]).queryByText('Mermaid 문법 오류')).not.toBeInTheDocument()
        expect(splitImageBtn).toBeEnabled()
      })

      // 3. WYSIWYG mode: inline 이미지 복사 before 코드 복사, scoped failure alert, sanitized log, and 1500ms feedback timer
      await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
      await waitFor(() => {
        expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
        expect(
          within(screen.getAllByTestId('wysiwyg-mermaid-block')[0]).getByRole('button', {
            name: '이미지 복사'
          })
        ).toBeEnabled()
      })

      const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
      const wysiwygValidToolbar = within(wysiwygBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(wysiwygValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])
      expect(
        within(wysiwygBlocks[1]).getByRole('button', { name: '이미지 복사' })
      ).toBeDisabled()
      expect(
        within(wysiwygBlocks[2]).getByRole('button', { name: '이미지 복사' })
      ).toBeDisabled()

      const wysiwygValidImageBtn = within(wysiwygValidToolbar).getByRole('button', {
        name: '이미지 복사'
      })

      shouldFailCopyImage = true
      await user.click(wysiwygValidImageBtn)
      await waitFor(() => {
        expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toHaveTextContent(
          'App PNG clipboard failed'
        )
      })
      const wysiwygActionAlert = wysiwygBlocks[0].querySelector('.mermaid-action-error')
      expect(wysiwygActionAlert).toHaveAttribute('role', 'alert')
      expect(wysiwygBlocks[1].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygBlocks[2].querySelector('.mermaid-action-error')).toBeNull()

      const imageFailureLogs = logEntries.filter(
        (entry) => entry.message === 'Mermaid image copy failed'
      )
      expect(imageFailureLogs).toHaveLength(1)
      expect(imageFailureLogs[0]).toMatchObject({
        level: 'error',
        category: 'ui',
        data: {
          theme: 'light',
          codeLength: validSource.length,
          byteLength: 6
        }
      })
      expect(typeof (imageFailureLogs[0].data as { svgLength?: unknown }).svgLength).toBe('number')
      expect(JSON.stringify(imageFailureLogs[0])).not.toContain('SECRET_APP_IMG')
      expect(JSON.stringify(imageFailureLogs[0])).not.toContain('<svg')
      expect(JSON.stringify(imageFailureLogs[0])).not.toContain('137')

      shouldFailCopyImage = false
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(wysiwygValidImageBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygValidImageBtn).toHaveTextContent('복사됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(wysiwygValidImageBtn).not.toHaveTextContent('복사됨')
      vi.useRealTimers()

      // Return to Raw: lossless roundtrip and clean buffer without dirty flag
      await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    } finally {
      canvasStub.restore()
      vi.useRealTimers()
      cleanup()
    }
  })

  it('supports Mermaid PNG and SVG file export with sanitized document title across Preview, Split, and WYSIWYG modes', async () => {
    const user = userEvent.setup()
    const validSource = 'graph TD\n  SECRET_APP_SAVE --> ServiceC'
    const brokenSource = 'graph TD\n  SYNTAX_ERROR'
    const docContent = [
      '# Mermaid Save E2E',
      '',
      '```mermaid',
      validSource,
      '```',
      '',
      '```mermaid',
      brokenSource,
      '```',
      '',
      '```mermaid',
      '   ',
      '```'
    ].join('\n')

    const logEntries: RendererLogPayload[] = []
    let nextSaveOutcome: 'confirm' | 'cancel' | 'fail' = 'confirm'
    const savedRequests: DiagramSaveRequest[] = []
    const saveFile = vi.fn(async (request: DiagramSaveRequest) => {
      savedRequests.push(request)
      if (nextSaveOutcome === 'fail') {
        throw new Error('App diagram file save failed')
      }
      if (nextSaveOutcome === 'cancel') {
        return { canceled: true }
      }
      return {
        canceled: false,
        filePath: `C:\\exports\\${request.suggestedName}`
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\mermaid-file-save',
        workspaces: {
          'C:\\wiki\\mermaid-file-save': {
            '아키텍처<설계>-v1.md': docContent
          }
        },
        diagram: { saveFile },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            logEntries.push(payload)
          })
        }
      }
    )
    window.wikiApi = api

    const canvasStub = installSvgCanvasStub()
    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('아키텍처<설계>-v1.md'))

      const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })

      // 1. Preview mode: 4 buttons in order, PNG light export, dark SVG export, dialog cancel, disabled states
      await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
      await waitFor(() => {
        expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      const previewBlocks = screen.getAllByTestId('mermaid-diagram')
      const previewValidToolbar = within(previewBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(previewValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])

      const previewSavePngBtn = within(previewValidToolbar).getByRole('button', {
        name: 'PNG 저장'
      })
      const previewSaveSvgBtn = within(previewValidToolbar).getByRole('button', {
        name: 'SVG 저장'
      })
      expect(previewSavePngBtn).toBeEnabled()
      expect(previewSaveSvgBtn).toBeEnabled()
      expect(within(previewBlocks[1]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(previewBlocks[1]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()
      expect(within(previewBlocks[1]).getByRole('button', { name: '코드 복사' })).toBeEnabled()
      expect(within(previewBlocks[2]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(previewBlocks[2]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()

      await user.hover(previewBlocks[0])
      await user.click(previewSavePngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(1)
        expect(previewSavePngBtn).toHaveTextContent('저장됨')
      })
      expect(previewSavePngBtn).toHaveAttribute('title', '저장됨')
      expect(savedRequests[0].format).toBe('png')
      expect(savedRequests[0].suggestedName).toBe('아키텍처설계-v1-diagram.png')
      expect(savedRequests[0].data).toEqual(new Uint8Array([137, 80, 78, 71, 1, 544 & 0xff]))
      expect(canvasStub.calls[0]).toMatchObject({ pixelWidth: 544, pixelHeight: 304 })
      expect(canvasStub.calls[0].decodedSvg).toContain('width="272"')
      expect(canvasStub.calls[0].decodedSvg).toContain('height="152"')
      expect(canvasStub.calls[0].decodedSvg).toContain('fill="#ffffff"')

      // Toggle dark theme -> SVG 저장 exports standalone XML SVG with #161b22 background and 16px margin
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'dark')
        expect(previewSaveSvgBtn).toBeEnabled()
      })
      await user.hover(previewBlocks[0])
      await user.click(previewSaveSvgBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(2)
        expect(previewSaveSvgBtn).toHaveTextContent('저장됨')
      })
      expect(savedRequests[1].format).toBe('svg')
      expect(savedRequests[1].suggestedName).toBe('아키텍처설계-v1-diagram.svg')
      const svgText = String(savedRequests[1].data)
      const parsedSvgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      expect(parsedSvgDoc.querySelector('parsererror')).toBeNull()
      expect(svgText).toContain('xmlns="http://www.w3.org/2000/svg"')
      expect(svgText).toContain('width="272"')
      expect(svgText).toContain('height="152"')
      expect(svgText).toContain('fill="#161b22"')

      // Dialog cancel leaves no saved feedback and no error alert
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'default')
        expect(previewSaveSvgBtn).toBeEnabled()
      })
      nextSaveOutcome = 'cancel'
      await user.click(previewSavePngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(3)
        expect(previewSavePngBtn).toBeEnabled()
      })
      expect(previewSavePngBtn).not.toHaveTextContent('저장됨')
      expect(previewBlocks[0].querySelector('.mermaid-action-error')).toBeNull()
      nextSaveOutcome = 'confirm'

      // 2. Split mode: PNG/SVG export uses document title, syntax error disables both while keeping 코드 복사 active
      await user.click(within(modeGroup).getByRole('button', { name: 'Split' }))
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      await waitFor(() => {
        expect(within(splitPreview).getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(
          within(within(splitPreview).getAllByTestId('mermaid-diagram')[0]).getByRole('button', {
            name: 'PNG 저장'
          })
        ).toBeEnabled()
      })

      const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
      const splitSavePngBtn = within(splitBlocks[0]).getByRole('button', { name: 'PNG 저장' })
      const splitSaveSvgBtn = within(splitBlocks[0]).getByRole('button', { name: 'SVG 저장' })
      const splitCodeBtn = within(splitBlocks[0]).getByRole('button', { name: '코드 복사' })
      await user.hover(splitBlocks[0])
      await user.click(splitSaveSvgBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(4)
      })
      expect(savedRequests[3].format).toBe('svg')
      expect(savedRequests[3].suggestedName).toBe('아키텍처설계-v1-diagram.svg')

      const splitRawEditor = document.querySelector('.editor-split-region.is-raw') as HTMLElement
      setRawEditorText(
        splitRawEditor,
        docContent.replace(validSource, 'graph TD\n  SYNTAX_ERROR_LIVE_SAVE')
      )
      expect(splitSavePngBtn).toBeDisabled()
      expect(splitSaveSvgBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()
      await waitFor(() => {
        expect(within(splitBlocks[0]).getByText('Mermaid 문법 오류')).toBeInTheDocument()
      })
      expect(splitSavePngBtn).toBeDisabled()
      expect(splitSaveSvgBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()

      setRawEditorText(splitRawEditor, docContent)
      await waitFor(() => {
        expect(within(splitBlocks[0]).queryByText('Mermaid 문법 오류')).not.toBeInTheDocument()
        expect(splitSavePngBtn).toBeEnabled()
        expect(splitSaveSvgBtn).toBeEnabled()
      })

      // 3. WYSIWYG mode: 4 buttons, doc title propagation, failure alert + sanitized logs, and 1500ms timer revert
      await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
      await waitFor(() => {
        expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
        expect(
          within(screen.getAllByTestId('wysiwyg-mermaid-block')[0]).getByRole('button', {
            name: 'SVG 저장'
          })
        ).toBeEnabled()
      })

      const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
      const wysiwygValidToolbar = within(wysiwygBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(wysiwygValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])
      expect(within(wysiwygBlocks[1]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(wysiwygBlocks[1]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()
      expect(within(wysiwygBlocks[2]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(wysiwygBlocks[2]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()

      const wysiwygSavePngBtn = within(wysiwygValidToolbar).getByRole('button', {
        name: 'PNG 저장'
      })
      const wysiwygSaveSvgBtn = within(wysiwygValidToolbar).getByRole('button', {
        name: 'SVG 저장'
      })

      nextSaveOutcome = 'fail'
      await user.click(wysiwygSaveSvgBtn)
      await waitFor(() => {
        expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toHaveTextContent(
          'App diagram file save failed'
        )
      })
      const svgSaveAlert = wysiwygBlocks[0].querySelector('.mermaid-action-error')
      expect(svgSaveAlert).toHaveAttribute('role', 'alert')
      expect(wysiwygBlocks[1].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygBlocks[2].querySelector('.mermaid-action-error')).toBeNull()

      await user.click(wysiwygSavePngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(6)
      })
      expect(savedRequests[4].suggestedName).toBe('아키텍처설계-v1-diagram.svg')
      expect(savedRequests[5].suggestedName).toBe('아키텍처설계-v1-diagram.png')

      const saveFailureLogs = logEntries.filter(
        (entry) =>
          entry.level === 'error' &&
          (entry.message === 'Mermaid SVG save failed' ||
            entry.message === 'Mermaid PNG save failed')
      )
      expect(saveFailureLogs).toHaveLength(2)
      expect(saveFailureLogs[0]).toMatchObject({
        message: 'Mermaid SVG save failed',
        data: {
          format: 'svg',
          theme: 'light',
          codeLength: validSource.length
        }
      })
      expect(typeof (saveFailureLogs[0].data as { svgLength?: unknown }).svgLength).toBe('number')
      expect(saveFailureLogs[1]).toMatchObject({
        message: 'Mermaid PNG save failed',
        data: {
          format: 'png',
          theme: 'light',
          codeLength: validSource.length,
          byteLength: 6
        }
      })
      const serializedFailureData = JSON.stringify(saveFailureLogs.map((entry) => entry.data))
      expect(serializedFailureData).not.toContain('SECRET_APP_SAVE')
      expect(serializedFailureData).not.toContain('아키텍처')
      expect(serializedFailureData).not.toContain('<svg')
      expect(serializedFailureData).not.toContain('137')

      // Recover via PNG save and verify 1500ms '저장됨' indicator revert
      nextSaveOutcome = 'confirm'
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(wysiwygSavePngBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygSavePngBtn).toHaveTextContent('저장됨')
      expect(wysiwygSavePngBtn).toHaveAttribute('title', '저장됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(wysiwygSavePngBtn).not.toHaveTextContent('저장됨')
      expect(wysiwygSavePngBtn).toHaveAttribute('title', 'PNG 저장')
      vi.useRealTimers()

      // Return to Raw: lossless roundtrip and clean buffer without dirty flag
      await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    } finally {
      canvasStub.restore()
      vi.useRealTimers()
      cleanup()
    }
  })

  it('updates sidebar Outline ignoring code fences, toggles showHeadingNumbers only for Outline with persistence, and scrolls to headings across modes', async () => {
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

      // Preview renders source headings without dynamic numbering even when showHeadingNumbers is true
      const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
      await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
      const setupHeading = screen.getByRole('heading', { level: 2, name: 'Setup' })
      expect(setupHeading.textContent).toBe('Setup')

      scrollIntoViewMock.mockClear()
      await user.click(within(items[2]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // Toggle "목차 번호 표시" off via Outline button -> hides numbers in Outline only without dirtying buffer or re-scrolling
      const outlineToggleBtn = within(outline).getByRole('button', { name: '목차 번호 표시' })
      expect(outlineToggleBtn).toHaveAttribute('aria-pressed', 'true')
      await user.click(outlineToggleBtn)
      expect(outlineToggleBtn).toHaveAttribute('aria-pressed', 'false')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('heading', { level: 2, name: 'Setup' }).textContent).toBe('Setup')
      expect(within(outline).queryByText('1.1.')).not.toBeInTheDocument()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(getFilesSnapshot().get('C:/wiki/outline/guide.md')).toBe(guideDoc)

      // Verify WYSIWYG mode renders without dynamic numbers and performs one-shot click-to-scroll
      await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
      expect(screen.getByTestId('document-editor').querySelector('.heading-number')).toBeNull()
      scrollIntoViewMock.mockClear()
      const currentItems = within(within(outline).getByRole('list')).getAllByRole('listitem')
      await user.click(within(currentItems[1]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // SettingsPanel no longer includes "헤딩 자동 넘버링 표시"; outline toggle state persists across restart
      await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      const settingsPanel = screen.getByLabelText('전역 설정 패널')
      expect(
        within(settingsPanel).queryByRole('checkbox', { name: /헤딩 자동 넘버링 표시/i })
      ).not.toBeInTheDocument()
      await user.click(within(settingsPanel).getByRole('button', { name: '닫기' }))

      firstRender.unmount()
      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('guide.md'))
      const reopenedOutline = within(
        screen.getByRole('complementary', { name: '우측 사이드바' })
      ).getByRole('region', { name: '문서 목차 (Outline)' })
      expect(
        within(reopenedOutline).getByRole('button', { name: '목차 번호 표시' })
      ).toHaveAttribute('aria-pressed', 'false')
      expect(within(reopenedOutline).queryByText('1.1.')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('does not render removed TOC insertion or body heading numbering buttons in Outline or editor toolbars', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: true },
      {
        selectedFolder: 'C:\\wiki\\no-toc-actions',
        workspaces: {
          'C:\\wiki\\no-toc-actions': {
            'manual.md': '# Title\n\n## Section'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('manual.md'))

    const outline = within(
      screen.getByRole('complementary', { name: '우측 사이드바' })
    ).getByRole('region', { name: '문서 목차 (Outline)' })
    expect(
      within(outline).queryByRole('button', { name: '본문에 목차(/toc) 삽입' })
    ).not.toBeInTheDocument()
    expect(
      within(outline).queryByRole('button', { name: '본문 헤딩 번호 쓰기' })
    ).not.toBeInTheDocument()
    expect(
      within(outline).queryByRole('button', { name: '본문 헤딩 번호 제거' })
    ).not.toBeInTheDocument()

    const rawToolbar = screen.getByRole('toolbar', { name: 'Raw 표 편집 툴바' })
    expect(within(rawToolbar).queryByRole('button', { name: '목차 삽입' })).not.toBeInTheDocument()

    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: '위지윅'
      })
    )
    const wysiwygToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
    expect(
      within(wysiwygToolbar).queryByRole('button', { name: '목차 삽입' })
    ).not.toBeInTheDocument()
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
    expect(within(rightSidebar).getByRole('button', { name: '목차 번호 표시' })).toBeInTheDocument()

    await user.click(await within(explorer).findByText('notes.txt'))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBe(rightSidebar)
    expect(
      within(rightSidebar).getByText('마크다운 문서에서만 목차를 지원합니다.')
    ).toBeInTheDocument()
    expect(
      within(rightSidebar).queryByRole('button', { name: '본문에 목차(/toc) 삽입' })
    ).not.toBeInTheDocument()
    expect(
      within(rightSidebar).queryByRole('button', { name: '본문 헤딩 번호 쓰기' })
    ).not.toBeInTheDocument()
    expect(
      within(rightSidebar).queryByRole('button', { name: '본문 헤딩 번호 제거' })
    ).not.toBeInTheDocument()

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
      const outlineListContainer = within(outlineRegion).getByRole('list').parentElement as HTMLElement
      assertSidebarPanelIsolation(outlineRegion, outlineHeader, outlineListContainer)

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

  it('integrates Split mode live preview/Mermaid, per-tab clamped splitter ratio, 2-pane workspace independence, non-markdown lock, and split breadcrumbs', async () => {
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

  it('renders relative workspace images across WYSIWYG, Preview, and Split with responsive CSS and zero wiki-asset leak on disk', async () => {
    const user = userEvent.setup()
    const docContent = [
      '# ![Logo](./assets/logo%20(1).png) Guide',
      '',
      '![Diagram](../shared/arch.svg)',
      '',
      '![Remote](https://example.com/hero.png)'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, showHeadingNumbers: false },
      {
        selectedFolder: 'C:/wiki/image-vault',
        workspaces: {
          'C:/wiki/image-vault': {
            'docs/guide.md': docContent,
            'docs/assets/logo (1).png': 'png-bytes',
            'shared/arch.svg': '<svg></svg>'
          }
        }
      }
    )
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      const explorer = screen.getByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('docs'))
      await user.click(await within(explorer).findByText('guide.md'))

      const expectedLogoUrl = buildWikiAssetUrl('C:/wiki/image-vault/docs/assets/logo (1).png')
      const expectedArchUrl = buildWikiAssetUrl('C:/wiki/image-vault/shared/arch.svg')

      // Outline preserves alt text cleanly without '.png)' leakage
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      expect(within(outline).getByRole('button', { name: /Logo Guide/ })).toBeInTheDocument()

      // Switch to WYSIWYG (Ctrl+2)
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '2', ctrlKey: true })
      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute('src', expectedLogoUrl)
      })

      const wysiwygDiagram = screen.getByRole('img', { name: 'Diagram' })
      expect(wysiwygDiagram).toHaveAttribute('src', expectedArchUrl)
      expect(wysiwygDiagram).toHaveAttribute('data-markdown-src', '../shared/arch.svg')
      expect(wysiwygDiagram.hasAttribute('width')).toBe(false)
      expect(wysiwygDiagram.hasAttribute('height')).toBe(false)
      expect(screen.getByRole('img', { name: 'Remote' })).toHaveAttribute(
        'src',
        'https://example.com/hero.png'
      )
      const wysiwygLogoStyle = window.getComputedStyle(screen.getByRole('img', { name: 'Logo' }))
      expect(wysiwygLogoStyle.maxWidth).toBe('100%')
      expect(wysiwygLogoStyle.height).toBe('auto')

      // Switch to Preview (Ctrl+3)
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '3', ctrlKey: true })
      const previewLogo = await screen.findByRole('img', { name: 'Logo' })
      expect(previewLogo).toHaveAttribute('src', expectedLogoUrl)
      expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('src', expectedArchUrl)
      expect(screen.getByRole('img', { name: 'Remote' })).toHaveAttribute(
        'src',
        'https://example.com/hero.png'
      )
      const previewLogoStyle = window.getComputedStyle(previewLogo)
      expect(previewLogoStyle.maxWidth).toBe('100%')
      expect(previewLogoStyle.height).toBe('auto')

      // Switch to Split (Ctrl+4)
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      const splitLogo = within(splitPreview).getByRole('img', { name: 'Logo' })
      expect(splitLogo).toHaveAttribute('src', expectedLogoUrl)
      const splitLogoStyle = window.getComputedStyle(splitLogo)
      expect(splitLogoStyle.maxWidth).toBe('100%')
      expect(splitLogoStyle.height).toBe('auto')
      expect(screen.getByTestId('document-editor').textContent).toContain('./assets/logo%20(1).png')
      expect(screen.getByTestId('document-editor').textContent).not.toContain('wiki-asset:')

      // Switch back to Raw (Ctrl+1) and verify saved file content never leaks wiki-asset:
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '1', ctrlKey: true })
      const rawContent = screen.getByTestId('document-editor').textContent ?? ''
      expect(rawContent).not.toContain('wiki-asset:')
      expect(await api.workspace.readFile('C:/wiki/image-vault/docs/guide.md')).toBe(docContent)
    } finally {
      cleanup()
    }
  })

  it('ingests clipboard pastes and FolderTree/OS drops end-to-end across Raw, WYSIWYG, and Split while blocking window navigation and surfacing Error Banner failures', async () => {
    const pathMap = new Map<string, string>([['os-shot.png', 'D:/outside/os-shot.png']])
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/img-app',
        workspaces: {
          'C:/wiki/img-app': {
            'docs/guide.md': '# Guide\n\n',
            'shared/arch (1).png': '<binary:arch>',
            'docs/notes.txt': 'plain note'
          }
        },
        getPathForFile: (file) => pathMap.get(file.name) ?? ''
      }
    )
    const ingestSpy = vi.spyOn(api.workspace, 'ingestImage')
    window.wikiApi = api

    const user = userEvent.setup()
    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    const docsTreeItem = await within(explorer).findByRole('treeitem', { name: 'docs' })
    await user.click(within(docsTreeItem).getByText('docs'))
    const guideItem = await within(explorer).findByRole('treeitem', { name: 'guide.md' })
    await user.click(within(guideItem).getByText('guide.md'))

    // Open shared directory to expose FolderTree image item
    const sharedTreeItem = await within(explorer).findByRole('treeitem', { name: 'shared' })
    await user.click(within(sharedTreeItem).getByText('shared'))
    const archTreeItem = await within(explorer).findByRole('treeitem', { name: 'arch (1).png' })
    expect(archTreeItem).toHaveAttribute('draggable', 'true')
    expect(guideItem).toHaveAttribute('draggable', 'true')

    // 1. FolderTree drag -> drop onto Raw editor references ../shared/arch%20%281%29.png without copying to assets/
    const dragTransferStore = new Map<string, string>()
    fireEvent.dragStart(archTreeItem, {
      dataTransfer: {
        effectAllowed: 'none',
        setData: (type: string, value: string) => {
          dragTransferStore.set(type, value)
        }
      }
    })
    // PaneWorkspace split drop zones stay inactive during FolderTree image drag
    expect(screen.queryByTestId('split-drop-zone-horizontal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()

    const rawEditor = await screen.findByTestId('document-editor')
    fireEvent.drop(rawEditor, {
      dataTransfer: {
        types: [...dragTransferStore.keys()],
        files: [],
        getData: (type: string) => dragTransferStore.get(type) ?? ''
      }
    })
    fireEvent.dragEnd(archTreeItem)

    await waitFor(() => {
      expect(getRawEditorText(rawEditor)).toContain('![arch (1)](../shared/arch%20%281%29.png)')
    })
    expect(getFilesSnapshot().has('C:/wiki/img-app/docs/assets/arch (1).png')).toBe(false)

    // 2. Clipboard bitmap paste in Raw mode saves under docs/assets/ and preserves normal text+bitmap paste
    const clipFile = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    fireEvent.paste(rawEditor, {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(getRawEditorText(rawEditor)).toContain(
        '![guide-20260402-090507](./assets/guide-20260402-090507.png)'
      )
    })
    expect(getFilesSnapshot().has('C:/wiki/img-app/docs/assets/guide-20260402-090507.png')).toBe(
      true
    )

    const callsAfterClip = ingestSpy.mock.calls.length
    fireEvent.paste(rawEditor, {
      clipboardData: {
        types: ['text/plain', 'Files'],
        files: [clipFile],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'a\tb\tc' : '')
      }
    })
    expect(ingestSpy).toHaveBeenCalledTimes(callsAfterClip)

    // 3. Switch to 위지윅 (Ctrl+2) and drop multi-file OS Explorer payload (path + bytes fallback)
    fireEvent.keyDown(rawEditor, { key: '2', ctrlKey: true })
    const wysiwygEditor = await screen.findByRole('textbox', { name: '위지윅 문서 에디터' })
    const osShot = new File([new Uint8Array([4, 5])], 'os-shot.png', { type: 'image/png' })
    const byteShot = new File([new Uint8Array([6, 7])], 'bytes-shot.webp', { type: 'image/webp' })
    fireEvent.drop(wysiwygEditor, {
      dataTransfer: {
        types: ['Files'],
        files: [osShot, byteShot],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'os-shot' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:/wiki/img-app/docs/assets/os-shot.png')
      )
      expect(screen.getByRole('img', { name: 'bytes-shot' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:/wiki/img-app/docs/assets/bytes-shot.webp')
      )
    })

    // 4. Switch to Split (Ctrl+4) and verify immediate Preview render & zero wiki-asset: leak
    fireEvent.keyDown(wysiwygEditor, { key: '4', ctrlKey: true })
    const splitPreview = await screen.findByTestId('split-markdown-preview')
    expect(within(splitPreview).getByRole('img', { name: 'os-shot' })).toHaveAttribute(
      'src',
      buildWikiAssetUrl('C:/wiki/img-app/docs/assets/os-shot.png')
    )
    const splitRawEditor = screen.getByTestId('document-editor')
    expect(getRawEditorText(splitRawEditor)).not.toContain('wiki-asset:')

    // Split left Raw editor falls back to ImageTransferContext.draggingWorkspaceImagePaths when getData() is empty
    appendRawEditorText(splitRawEditor, '\n\n')
    const splitIngestsBefore = ingestSpy.mock.calls.length
    fireEvent.dragStart(archTreeItem, {
      dataTransfer: {
        effectAllowed: 'none',
        setData: () => undefined
      }
    })
    fireEvent.drop(splitRawEditor, {
      dataTransfer: {
        types: ['application/x-wiki-workspace-image'],
        files: [],
        getData: () => ''
      }
    })
    fireEvent.dragEnd(archTreeItem)
    await waitFor(() => {
      expect(ingestSpy).toHaveBeenCalledTimes(splitIngestsBefore + 1)
      expect(within(splitPreview).getAllByRole('img', { name: 'arch (1)' })).toHaveLength(2)
    })

    // 5. Window-level drop outside editors prevents accidental Electron file navigation
    const outerDropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(outerDropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [osShot], getData: () => '' }
    })
    explorer.dispatchEvent(outerDropEvent)
    expect(outerDropEvent.defaultPrevented).toBe(true)

    // 6. Config/non-markdown buffer disables clipboard image ingestion
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(await screen.findByRole('button', { name: /설정 파일 직접 열기/i }))
    await waitFor(() => {
      expect(screen.getByTestId('document-editor')).toHaveAttribute('data-language', 'json')
    })
    const callsBeforeConfigPaste = ingestSpy.mock.calls.length
    fireEvent.paste(screen.getByTestId('document-editor'), {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })
    expect(ingestSpy).toHaveBeenCalledTimes(callsBeforeConfigPaste)

    // 7. Ingestion failure surfaces via Error Banner (role="alert")
    const guideTab = screen.getByRole('tab', { name: /guide\.md/i })
    await user.click(guideTab)
    ingestSpy.mockRejectedValueOnce(new Error('디스크 공간 부족'))
    fireEvent.paste(await screen.findByTestId('document-editor'), {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/이미지 삽입에 실패했습니다.*디스크 공간 부족/)
    })
  })
})

describe('Read-only image preview tabs', () => {
  it('opens supported image files from the folder tree as read-only preview tabs without UTF-8 reads or writes', async () => {
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 40 },
      {
        selectedFolder: 'C:/wiki/img-preview',
        workspaces: {
          'C:/wiki/img-preview': {
            'docs/guide.md': '# Guide\n\nBody',
            'assets/diagram.png': '<binary-png>',
            'assets/photo.jpg': '<binary-jpg>',
            'assets/frame.jpeg': '<binary-jpeg>',
            'assets/anim.gif': '<binary-gif>',
            'assets/hero.webp': '<binary-webp>',
            'assets/vector.svg': '<svg></svg>',
            'assets/icon.bmp': '<binary-bmp>',
            'assets/modern.AVIF': '<binary-avif>'
          }
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    const writeFileSpy = vi.spyOn(api.workspace, 'writeFile')
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      const user = userEvent.setup()
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      const explorer = screen.getByLabelText('워크스페이스 탐색기')
      const docsTreeItem = await within(explorer).findByRole('treeitem', { name: 'docs' })
      await user.click(within(docsTreeItem).getByText('docs'))
      await user.click(await within(explorer).findByText('guide.md'))
      expect(readFileSpy).toHaveBeenCalledTimes(1)
      expect(readFileSpy).toHaveBeenCalledWith('C:/wiki/img-preview/docs/guide.md')

      // Expand assets and click diagram.png -> opens read-only image preview WITHOUT readFile
      const assetsTreeItem = await within(explorer).findByRole('treeitem', { name: 'assets' })
      await user.click(within(assetsTreeItem).getByText('assets'))
      await user.click(await within(explorer).findByText('diagram.png'))

      const previewContainer = await screen.findByTestId('image-preview')
      const img = within(previewContainer).getByRole('img', { name: 'diagram.png' })
      expect(img).toHaveAttribute('src', buildWikiAssetUrl('C:/wiki/img-preview/assets/diagram.png'))
      expect(readFileSpy).toHaveBeenCalledTimes(1)

      // Centered & responsive layout CSS applied via themeCss
      const containerStyle = getComputedStyle(previewContainer)
      const imgStyle = getComputedStyle(img)
      expect(containerStyle.display).toBe('flex')
      expect(containerStyle.alignItems).toBe('center')
      expect(containerStyle.justifyContent).toBe('center')
      expect(imgStyle.maxWidth).toBe('100%')
      expect(imgStyle.maxHeight).toBe('100%')

      // Header displays read-only status and disables modes & Save
      expect(screen.getByText('읽기 전용')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
      for (const label of ['Raw', '위지윅', 'Preview', 'Split']) {
        expect(screen.getByRole('button', { name: label })).toBeDisabled()
      }
      expect(screen.queryByTestId('document-editor')).not.toBeInTheDocument()

      // Document Outline treats active image tab as non-markdown
      const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
      expect(within(rightSidebar).getByText('마크다운 문서에서만 목차를 지원합니다.')).toBeInTheDocument()

      // Global shortcuts (Ctrl+S, Ctrl+1..4, Ctrl+Shift+M) and auto-save timer never write binary image files
      fireEvent.keyDown(window, { key: 's', ctrlKey: true })
      fireEvent.keyDown(window, { key: '2', ctrlKey: true })
      fireEvent.keyDown(window, { key: '4', ctrlKey: true })
      fireEvent.keyDown(window, { key: 'M', ctrlKey: true, shiftKey: true })
      await new Promise((resolve) => setTimeout(resolve, 90))
      expect(writeFileSpy).not.toHaveBeenCalled()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

      // Context menu "열기" on case-insensitive .AVIF opens image preview without readFile
      fireEvent.contextMenu(await within(explorer).findByText('modern.AVIF'))
      const menu = await screen.findByRole('menu')
      await user.click(within(menu).getByRole('menuitem', { name: '열기' }))
      const avifImg = within(await screen.findByTestId('image-preview')).getByRole('img', {
        name: 'modern.AVIF'
      })
      expect(avifImg).toHaveAttribute('src', buildWikiAssetUrl('C:/wiki/img-preview/assets/modern.AVIF'))

      // All remaining supported extensions open via click without readFile
      for (const filename of ['photo.jpg', 'frame.jpeg', 'anim.gif', 'hero.webp', 'vector.svg', 'icon.bmp']) {
        await user.click(await within(explorer).findByText(filename))
        const extImg = within(await screen.findByTestId('image-preview')).getByRole('img', { name: filename })
        expect(extImg).toHaveAttribute(
          'src',
          buildWikiAssetUrl(`C:/wiki/img-preview/assets/${filename}`)
        )
      }
      expect(readFileSpy).toHaveBeenCalledTimes(1)

      // Closing image tab skips unsaved-changes confirmation dialog
      await user.click(screen.getByRole('button', { name: 'diagram.png 탭 닫기' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('tab', { name: /diagram\.png/i })).not.toBeInTheDocument()
    } finally {
      cleanup()
    }
  })

  it('supports tab switching, moving, duplicating across panes, and horizontal/vertical split modes alongside markdown tabs', async () => {
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-img',
        workspaces: {
          'C:/wiki/split-img': {
            'docs/spec.md': '# Spec\n\nDetails',
            'assets/mockup.png': '<binary-png>'
          }
        }
      }
    )
    window.wikiApi = api

    const user = userEvent.setup()
    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(within(await within(explorer).findByRole('treeitem', { name: 'docs' })).getByText('docs'))
    await user.click(await within(explorer).findByText('spec.md'))
    await user.click(within(await within(explorer).findByRole('treeitem', { name: 'assets' })).getByText('assets'))
    await user.click(await within(explorer).findByText('mockup.png'))

    const workspaceEl = screen.getByTestId('pane-workspace')
    const primaryPane = screen.getByTestId('pane-primary')
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Tab switching between markdown and image tabs
    await user.click(within(primaryPane).getByRole('tab', { name: /spec\.md/i }))
    expect(within(primaryPane).getByTestId('document-editor')).toBeInTheDocument()
    expect(within(primaryPane).queryByTestId('image-preview')).not.toBeInTheDocument()

    await user.click(within(primaryPane).getByRole('tab', { name: /mockup\.png/i }))
    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Move image tab into horizontal Split Mode next to markdown tab
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /mockup\.png/i }))
    const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(primaryPane).getByTestId('document-editor')).toBeInTheDocument()
    expect(within(secondaryPane).getByTestId('image-preview')).toBeInTheDocument()
    expect(within(secondaryPane).getByText('읽기 전용')).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('button', { name: '저장' })).toBeDisabled()

    // Edit & save markdown in primary while image remains open & read-only in secondary
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    appendRawEditorText(primaryEditor, '\nUpdated')
    fireEvent.keyDown(primaryEditor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(getFilesSnapshot().get('C:/wiki/split-img/docs/spec.md')).toContain('Updated')
    })

    // Switch split orientation to vertical via split drop zone
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /mockup\.png/i }))
    fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')
    expect(within(secondaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Duplicate image tab into primary pane so both panes display the image preview simultaneously
    fireEvent.contextMenu(within(secondaryPane).getByRole('tab', { name: /mockup\.png/i }))
    const dupMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(dupMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()
    expect(within(secondaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Closing secondary image tab auto-collapses split back to single while keeping primary image open
    await user.click(within(secondaryPane).getByRole('button', { name: 'mockup.png 탭 닫기' }))
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()
  })

  it('synchronizes open image tabs across file/folder renames, deletions, external watch events, and git mutations', async () => {
    const repoRoot = 'C:/wiki/sync-img'
    const baseGitStatus = {
      ...createEmptyGitStatus(true, repoRoot),
      branch: 'main'
    }
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: repoRoot,
        workspaces: {
          [repoRoot]: {
            'docs/other.md': '# Other',
            'assets/logo.png': '<png-v1>',
            'assets/delete-me.png': '<png-del>',
            'media/pic2.png': '<png-media>'
          }
        },
        git: {
          status: vi.fn(async () => baseGitStatus),
          pull: vi.fn(async () => baseGitStatus)
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    window.wikiApi = api

    const user = userEvent.setup()
    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    const assetsTreeItem = await within(explorer).findByRole('treeitem', { name: 'assets' })
    await user.click(within(assetsTreeItem).getByText('assets'))
    const mediaTreeItem = await within(explorer).findByRole('treeitem', { name: 'media' })
    await user.click(within(mediaTreeItem).getByText('media'))

    await user.click(await within(explorer).findByText('pic2.png'))
    await user.click(await within(explorer).findByText('delete-me.png'))
    await user.click(await within(explorer).findByText('logo.png'))

    expect(
      within(screen.getByTestId('image-preview')).getByRole('img', { name: 'logo.png' })
    ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/assets/logo.png`))

    // 1. Renaming open image file updates tab title, header meta, and wiki-asset URL immediately
    const logoItem = within(explorer).getByRole('treeitem', { name: 'logo.png' })
    logoItem.focus()
    fireEvent.keyDown(logoItem, { key: 'F2' })
    const fileRenameInput = await within(explorer).findByLabelText('새 이름 입력')
    await user.clear(fileRenameInput)
    await user.type(fileRenameInput, 'brand.png{Enter}')

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /brand\.png/i })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('brand.png', { selector: '.editor-doc-title' })).toBeInTheDocument()
      expect(screen.getByText(`${repoRoot}/assets/brand.png`)).toBeInTheDocument()
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/assets/brand.png`))
    })

    // 2. Renaming parent folder updates path & wiki-asset URL of open image tab
    const renamedAssetsItem = within(explorer).getByRole('treeitem', { name: 'assets' })
    renamedAssetsItem.focus()
    fireEvent.keyDown(renamedAssetsItem, { key: 'F2' })
    const folderRenameInput = await within(explorer).findByLabelText('새 이름 입력')
    await user.clear(folderRenameInput)
    await user.type(folderRenameInput, 'images{Enter}')

    await waitFor(() => {
      expect(screen.getByText(`${repoRoot}/images/brand.png`)).toBeInTheDocument()
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`))
    })

    // 3. Deleting an image file via FolderTree closes its tab cleanly
    fireEvent.contextMenu(await within(explorer).findByText('delete-me.png'))
    const deleteMenu = await screen.findByRole('menu')
    await user.click(within(deleteMenu).getByRole('menuitem', { name: /삭제/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i }))

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /delete-me\.png/i })).not.toBeInTheDocument()
    })

    // Switch back to brand.png
    await user.click(screen.getByRole('tab', { name: /brand\.png/i }))

    // 4. Unrelated workspace change event leaves existing image URL cache stable
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'change',
        relativePath: 'docs/other.md'
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
    ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`))

    // 5. External modification of the open image (direct path & coalesced null) busts preview URL cache without readFile
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'change',
        relativePath: 'images/brand.png'
      })
    })
    await waitFor(() => {
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`, 2))
    })

    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'change',
        relativePath: null
      })
    })
    await waitFor(() => {
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`, 3))
    })

    // 6. Git workspace mutation refreshes open image cache without readFile
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: 'Pull' }))
    await waitFor(() => {
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`, 4))
    })

    // 7. External parent folder deletion & external image deletion auto-close affected image tabs cleanly without alerts or readFile
    await api.workspace.deleteEntry(`${repoRoot}/media`)
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'rename',
        relativePath: 'media'
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pic2\.png/i })).not.toBeInTheDocument()
    })

    await api.workspace.deleteEntry(`${repoRoot}/images/brand.png`)
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'rename',
        relativePath: 'images/brand.png'
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /brand\.png/i })).not.toBeInTheDocument()
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readFileSpy).not.toHaveBeenCalled()
  })
})

describe('Folder tree context menu path copy', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('shows separated relative and absolute path copy items in folder tree context menu and copies formatted paths', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, copiedTexts } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/notes',
        workspaces: {
          'C:/wiki/notes': {
            'guides/setup.md': '# Setup'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    const guidesNode = await within(sidebar).findByText('guides')

    fireEvent.contextMenu(guidesNode)
    const dirMenu = await screen.findByRole('menu')
    expect(
      within(dirMenu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim())
    ).toEqual(['새 파일', '새 폴더', '상대 경로 복사', '절대 경로 복사', '이름 변경 (F2)', '삭제'])
    expect(within(dirMenu).getAllByRole('separator')).toHaveLength(2)

    await user.click(within(dirMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('guides')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.contextMenu(guidesNode)
    const dirMenu2 = await screen.findByRole('menu')
    await user.click(within(dirMenu2).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('C:\\wiki\\notes\\guides')

    await user.click(guidesNode)
    const setupFileNode = await within(sidebar).findByText('setup.md')

    fireEvent.contextMenu(setupFileNode)
    const fileMenu = await screen.findByRole('menu')
    expect(
      within(fileMenu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim())
    ).toEqual(['열기', '상대 경로 복사', '절대 경로 복사', '이름 변경 (F2)', '삭제'])
    expect(within(fileMenu).getAllByRole('separator')).toHaveLength(2)

    await user.click(within(fileMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('guides/setup.md')

    fireEvent.contextMenu(setupFileNode)
    const fileMenu2 = await screen.findByRole('menu')
    await user.click(within(fileMenu2).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('C:\\wiki\\notes\\guides\\setup.md')
  })

  it('copies updated relative and absolute paths for nested entries immediately after renaming an expanded parent folder', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, copiedTexts } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/notes',
        workspaces: {
          'C:/wiki/notes': {
            'guides/setup.md': '# Setup'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    const guidesNode = await within(sidebar).findByText('guides')
    await user.click(guidesNode)
    expect(await within(sidebar).findByText('setup.md')).toBeInTheDocument()

    const guidesTreeItem = within(sidebar).getByRole('treeitem', { name: 'guides' })
    guidesTreeItem.focus()
    fireEvent.keyDown(guidesTreeItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'handbook{Enter}')

    expect(await within(sidebar).findByText('handbook')).toBeInTheDocument()
    const nestedSetup = within(sidebar).getByText('setup.md')

    fireEvent.contextMenu(nestedSetup)
    const menu1 = await screen.findByRole('menu')
    await user.click(within(menu1).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe('handbook/setup.md')

    fireEvent.contextMenu(nestedSetup)
    const menu2 = await screen.findByRole('menu')
    await user.click(within(menu2).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe('C:\\wiki\\notes\\handbook\\setup.md')
  })

  it('closes context menu and displays error banner when clipboard path copy fails', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/notes',
        workspaces: {
          'C:/wiki/notes': {
            'guides/setup.md': '# Setup'
          }
        },
        clipboard: {
          async writeText() {
            throw new Error('클립보드 접근이 거부되었습니다.')
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    const guidesNode = await within(sidebar).findByText('guides')

    fireEvent.contextMenu(guidesNode)
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: '상대 경로 복사' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('클립보드 접근이 거부되었습니다.')
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

  it('handles Ctrl+K wrapping/unwrapping, modal/dialog blocking, and config.json exclusion', async () => {
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
              '- [Raw 이동](./raw-target.md)',
              '- [위지윅 이동](./wysiwyg-target.md)',
              '- [상하 이동](./vertical-target.md)',
              '',
              '본문 첫 줄',
              '',
              '## 세부 항목',
              '',
              '세부 본문'
            ].join('\n'),
            'docs/sibling.md': '# 형제 문서\n\n[현재 복귀](./current.md#개요)',
            'docs/raw-target.md': '# Raw 대상\n\n본문',
            'docs/wysiwyg-target.md': '# 위지윅 대상\n\n본문',
            'docs/vertical-target.md': '# 상하 분할 대상\n\n본문',
            'sub/guide (1).md': '# 가이드 시작\n\n안내 본문\n\n## 설정\n\n설정 값'
          }
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    const scrollIntoViewMock = vi.fn()
    const getHeadingScrollTargets = (): HTMLElement[] =>
      scrollIntoViewMock.mock.calls.flatMap((args, idx) =>
        (args[0] as ScrollIntoViewOptions | undefined)?.block === 'start'
          ? [scrollIntoViewMock.mock.instances[idx] as HTMLElement]
          : []
      )
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
      expect(getHeadingScrollTargets()).toHaveLength(1)
      expect(getHeadingScrollTargets()[0].id).toBe('세부-항목')
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

      const rawRelSpan = Array.from(rawCmContent.querySelectorAll('span')).find((el) =>
        el.textContent?.includes('./raw-target.md')
      )!
      fireEvent.click(rawRelSpan, { ctrlKey: true })
      const rawTargetTab = await within(primaryPane).findByRole('tab', { name: /raw-target\.md/i })
      expect(rawTargetTab).toHaveAttribute('aria-selected', 'true')
      await user.click(within(primaryPane).getByRole('tab', { name: /current\.md/i }))

      // 3) WYSIWYG mode: normal click does not jump, Meta+click scrolls heading, Ctrl+click opens relative file
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
        expect(getHeadingScrollTargets()).toHaveLength(1)
      })
      expect(getHeadingScrollTargets()[0].textContent).toContain('세부 항목')

      const wysiwygRelLink = Array.from(wysiwygEl.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === './wysiwyg-target.md'
      )!
      expect(fireEvent.click(wysiwygRelLink, { ctrlKey: true })).toBe(false)
      const wysiwygTargetTab = await within(primaryPane).findByRole('tab', {
        name: /wysiwyg-target\.md/i
      })
      expect(wysiwygTargetTab).toHaveAttribute('aria-selected', 'true')
      await user.click(within(primaryPane).getByRole('tab', { name: /current\.md/i }))

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
        expect(getHeadingScrollTargets()).toHaveLength(1)
      })
      expect(getHeadingScrollTargets()[0].id).toBe('개요')

      // Switch to vertical split mode and open relative link inside the clicked secondary vertical pane
      fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /sibling\.md/i }))
      fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')

      await user.click(within(secondaryPane).getByRole('tab', { name: /current\.md/i }))
      await user.click(within(secondaryPane).getByRole('button', { name: 'Preview' }))
      await user.click(within(secondaryPane).getByRole('link', { name: '상하 이동' }))

      const verticalTargetTab = await within(secondaryPane).findByRole('tab', {
        name: /vertical-target\.md/i
      })
      expect(verticalTargetTab).toHaveAttribute('aria-selected', 'true')
      expect(
        within(primaryPane).queryByRole('tab', { name: /vertical-target\.md/i })
      ).not.toBeInTheDocument()
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
              '- [비마크다운 파일](./diagram.png)',
              '- [파일은 있음](./target.md#missing-sec)'
            ].join('\n'),
            'docs/target.md': '# 존재하는 제목\n\n내용',
            'docs/diagram.png': 'PNGDATA'
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

    // 3b) Non-markdown relative file link is rejected without reading the file or creating entries
    const readCallsBeforeNonMd = readFileSpy.mock.calls.length
    await user.click(within(primaryPane).getByRole('link', { name: '비마크다운 파일' }))
    const nonMdAlert = await screen.findByRole('alert')
    expect(nonMdAlert).toHaveTextContent(/마크다운 문서만|지원하지 않는/)
    expect(readFileSpy).toHaveBeenCalledTimes(readCallsBeforeNonMd)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
    expect(createEntrySpy).not.toHaveBeenCalled()
    expect(within(primaryPane).getByRole('tab', { name: /index\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // 4) Existing target file + missing #slug opens target tab AND shows error banner
    await user.click(within(primaryPane).getByRole('link', { name: '파일은 있음' }))
    const targetTab = await within(primaryPane).findByRole('tab', { name: /target\.md/i })
    expect(targetTab).toHaveAttribute('aria-selected', 'true')
    const missingTargetSlugAlert = await screen.findByRole('alert')
    expect(missingTargetSlugAlert).toHaveTextContent(/missing-sec/)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
  })
})

describe('Folder tree multi-select and drag-and-drop move', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  function createTreeDataTransfer() {
    const store = new Map<string, string>()
    let dropEffect = 'none'
    let effectAllowed = 'none'
    return {
      get effectAllowed() {
        return effectAllowed
      },
      set effectAllowed(val: string) {
        effectAllowed = val
      },
      get dropEffect() {
        return dropEffect
      },
      set dropEffect(val: string) {
        dropEffect = val
      },
      get types() {
        return [...store.keys()]
      },
      files: [] as unknown as FileList,
      setData(type: string, value: string) {
        store.set(type, value)
      },
      getData(type: string) {
        return store.get(type) ?? ''
      }
    }
  }

  it('supports Ctrl/Cmd+click toggle, Shift+click visible range selection, multi-select context menu, F2 guard, and batch Delete', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, copiedTexts, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/multi',
        workspaces: {
          'C:/wiki/multi': {
            'alpha/a1.md': '# A1',
            'alpha/a2.md': '# A2',
            'beta/b1.md': '# B1',
            'note-1.md': '# Note 1',
            'note-2.md': '# Note 2',
            'note-3.md': '# Note 3'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    const alphaItem = await within(explorer).findByRole('treeitem', { name: 'alpha' })
    const betaItem = within(explorer).getByRole('treeitem', { name: 'beta' })
    const note1Item = within(explorer).getByRole('treeitem', { name: 'note-1.md' })
    const note2Item = within(explorer).getByRole('treeitem', { name: 'note-2.md' })
    const note3Item = within(explorer).getByRole('treeitem', { name: 'note-3.md' })

    // Normal click expands 'alpha' and selects only 'alpha'
    await user.click(within(alphaItem).getByText('alpha'))
    const a1Item = await within(explorer).findByRole('treeitem', { name: 'a1.md' })
    const a2Item = await within(explorer).findByRole('treeitem', { name: 'a2.md' })
    expect(alphaItem).toHaveAttribute('aria-selected', 'true')

    // Ctrl+click on collapsed 'beta' and 'note-2.md' toggles selection WITHOUT expanding beta or opening note-2.md
    fireEvent.click(within(betaItem).getByText('beta'), { ctrlKey: true })
    expect(betaItem).toHaveAttribute('aria-expanded', 'false')
    expect(alphaItem).toHaveAttribute('aria-selected', 'true')
    expect(betaItem).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    // Meta+click (macOS Cmd) also toggles selection
    fireEvent.click(within(note2Item).getByText('note-2.md'), { metaKey: true })
    expect(note2Item).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    // Ctrl+click again on 'alpha' deselects it
    fireEvent.click(within(alphaItem).getByText('alpha'), { ctrlKey: true })
    expect(alphaItem).toHaveAttribute('aria-selected', 'false')
    expect(alphaItem).toHaveAttribute('aria-expanded', 'true')

    // Normal click on 'a2.md' selects only 'a2.md' and opens tab
    await user.click(within(a2Item).getByText('a2.md'))
    expect(await screen.findByRole('tab', { name: /a2\.md/i })).toBeInTheDocument()
    expect(a2Item).toHaveAttribute('aria-selected', 'true')
    expect(betaItem).toHaveAttribute('aria-selected', 'false')
    expect(note2Item).toHaveAttribute('aria-selected', 'false')

    // Shift+click on 'note-2.md' selects visible range: a2.md, beta (collapsed, so b1.md skipped), note-1.md, note-2.md
    fireEvent.click(within(note2Item).getByText('note-2.md'), { shiftKey: true })
    expect(a1Item).toHaveAttribute('aria-selected', 'false')
    expect(a2Item).toHaveAttribute('aria-selected', 'true')
    expect(betaItem).toHaveAttribute('aria-selected', 'true')
    expect(note1Item).toHaveAttribute('aria-selected', 'true')
    expect(note2Item).toHaveAttribute('aria-selected', 'true')
    expect(note3Item).toHaveAttribute('aria-selected', 'false')
    expect(betaItem).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tab', { name: /note-2\.md/i })).not.toBeInTheDocument()

    // F2 is ignored while 2+ entries are selected
    note2Item.focus()
    fireEvent.keyDown(note2Item, { key: 'F2' })
    expect(within(explorer).queryByLabelText('새 이름 입력')).not.toBeInTheDocument()

    // Right-click on already-selected item preserves multi-selection and disables single-only items
    fireEvent.contextMenu(within(note1Item).getByText('note-1.md'))
    const multiMenu = await screen.findByRole('menu')
    expect(within(multiMenu).getByRole('menuitem', { name: '열기' })).toBeDisabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '이름 변경 (F2)' })).toBeDisabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '상대 경로 복사' })).toBeEnabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '절대 경로 복사' })).toBeEnabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '삭제' })).toBeEnabled()

    // Multi-copy relative paths joins visible selected paths with newline
    await user.click(within(multiMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe('alpha/a2.md\nbeta\nnote-1.md\nnote-2.md')

    // Multi-copy absolute paths joins formatted absolute paths with newline
    fireEvent.contextMenu(within(betaItem).getByText('beta'))
    const multiDirMenu = await screen.findByRole('menu')
    expect(within(multiDirMenu).getByRole('menuitem', { name: '새 파일' })).toBeDisabled()
    expect(within(multiDirMenu).getByRole('menuitem', { name: '새 폴더' })).toBeDisabled()
    expect(within(multiDirMenu).getByRole('menuitem', { name: '이름 변경 (F2)' })).toBeDisabled()
    await user.click(within(multiDirMenu).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe(
      [
        'C:\\wiki\\multi\\alpha\\a2.md',
        'C:\\wiki\\multi\\beta',
        'C:\\wiki\\multi\\note-1.md',
        'C:\\wiki\\multi\\note-2.md'
      ].join('\n')
    )

    // Right-click on unselected 'note-3.md' switches to single selection
    fireEvent.contextMenu(within(note3Item).getByText('note-3.md'))
    const singleMenu = await screen.findByRole('menu')
    expect(note3Item).toHaveAttribute('aria-selected', 'true')
    expect(note1Item).toHaveAttribute('aria-selected', 'false')
    expect(within(singleMenu).getByRole('menuitem', { name: '열기' })).toBeEnabled()
    expect(within(singleMenu).getByRole('menuitem', { name: '이름 변경 (F2)' })).toBeEnabled()
    fireEvent.keyDown(document, { key: 'Escape' })

    // Empty tree background click clears selection
    const treeEl = within(explorer).getByRole('tree')
    await user.click(treeEl)
    expect(note3Item).toHaveAttribute('aria-selected', 'false')

    // Multi-select a2.md, note-1.md, note-2.md, then Ctrl+click note-2.md to deselect it (focus moves to deselected note-2.md),
    // and press Delete -> deletes active selection [a2.md, note-1.md] and keeps deselected note-2.md
    await user.click(within(a2Item).getByText('a2.md'))
    fireEvent.click(within(note1Item).getByText('note-1.md'), { ctrlKey: true })
    fireEvent.click(within(note2Item).getByText('note-2.md'), { ctrlKey: true })
    fireEvent.click(within(note2Item).getByText('note-2.md'), { ctrlKey: true })
    expect(note2Item).toHaveAttribute('aria-selected', 'false')
    note2Item.focus()
    fireEvent.keyDown(note2Item, { key: 'Delete' })

    const deleteDialog = await screen.findByRole('alertdialog')
    expect(deleteDialog).toHaveTextContent('선택한 2개 항목을 삭제하시겠습니까?')
    await user.click(within(deleteDialog).getByRole('button', { name: /삭제 확인/i }))

    await waitFor(() => {
      expect(within(explorer).queryByRole('treeitem', { name: 'a2.md' })).not.toBeInTheDocument()
      expect(within(explorer).queryByRole('treeitem', { name: 'note-1.md' })).not.toBeInTheDocument()
    })
    expect(within(explorer).getByRole('treeitem', { name: 'note-2.md' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /a2\.md/i })).not.toBeInTheDocument()
    expect(getFilesSnapshot().has('C:/wiki/multi/alpha/a2.md')).toBe(false)
    expect(getFilesSnapshot().has('C:/wiki/multi/note-1.md')).toBe(false)
    expect(getFilesSnapshot().has('C:/wiki/multi/note-2.md')).toBe(true)
  })

  it('moves single/multi entries via drag-and-drop onto folder rows, file parent folders, and tree root, updates open tabs, auto-expands after 500ms, handles conflicts all-or-nothing, and drops multiple images into editor', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/dnd',
        workspaces: {
          'C:/wiki/dnd': {
            'dest/existing.md': '# Existing in dest',
            'dest/nested/deep.md': '# Deep',
            'src/doc.md': '# Doc',
            'src/pic1.png': '<png1>',
            'src/pic2.webp': '<webp2>',
            'conflict/existing.md': '# Conflicting',
            'conflict/clean.md': '# Clean',
            'root-note.md': '# Root Note'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    const treeEl = within(explorer).getByRole('tree')
    const srcFolder = await within(explorer).findByRole('treeitem', { name: 'src' })
    const destFolder = within(explorer).getByRole('treeitem', { name: 'dest' })
    const conflictFolder = within(explorer).getByRole('treeitem', { name: 'conflict' })
    const rootNoteItem = within(explorer).getByRole('treeitem', { name: 'root-note.md' })

    // Open src/doc.md in editor before moving it
    await user.click(within(srcFolder).getByText('src'))
    const docItem = await within(explorer).findByRole('treeitem', { name: 'doc.md' })
    const pic1Item = within(explorer).getByRole('treeitem', { name: 'pic1.png' })
    const pic2Item = within(explorer).getByRole('treeitem', { name: 'pic2.webp' })
    await user.click(within(docItem).getByText('doc.md'))
    const rawEditor = await screen.findByTestId('document-editor')

    // Dragging 'src' folder over itself must NOT highlight as a valid target
    const dtSelfFolder = createTreeDataTransfer()
    fireEvent.dragStart(srcFolder, { dataTransfer: dtSelfFolder })
    fireEvent.dragOver(srcFolder, { dataTransfer: dtSelfFolder })
    expect(srcFolder.querySelector('.tree-row')).not.toHaveClass('is-drop-target')
    fireEvent.dragEnd(srcFolder, { dataTransfer: dtSelfFolder })

    // Dragging only 'src/doc.md' over its own parent 'src' must NOT highlight (no-op)
    await user.click(within(docItem).getByText('doc.md'))
    const dtSameParent = createTreeDataTransfer()
    fireEvent.dragStart(docItem, { dataTransfer: dtSameParent })
    fireEvent.dragOver(srcFolder, { dataTransfer: dtSameParent })
    expect(srcFolder.querySelector('.tree-row')).not.toHaveClass('is-drop-target')
    fireEvent.dragEnd(docItem, { dataTransfer: dtSameParent })

    // 1. Multi-select doc.md + root-note.md and drag onto collapsed dest folder -> highlight & move
    await user.click(within(docItem).getByText('doc.md'))
    fireEvent.click(within(rootNoteItem).getByText('root-note.md'), { ctrlKey: true })
    const dtMove = createTreeDataTransfer()
    fireEvent.dragStart(docItem, { dataTransfer: dtMove })
    fireEvent.dragOver(destFolder, { dataTransfer: dtMove })
    expect(destFolder.querySelector('.tree-row')).toHaveClass('is-drop-target')
    expect(destFolder.querySelector('.tree-row')).toHaveAttribute('data-drop-target', 'true')
    expect(dtMove.dropEffect).toBe('move')
    fireEvent.drop(destFolder, { dataTransfer: dtMove })
    fireEvent.dragEnd(docItem, { dataTransfer: dtMove })

    await waitFor(() => {
      expect(getFilesSnapshot().has('C:/wiki/dnd/dest/doc.md')).toBe(true)
      expect(getFilesSnapshot().has('C:/wiki/dnd/dest/root-note.md')).toBe(true)
    })
    expect(getFilesSnapshot().has('C:/wiki/dnd/src/doc.md')).toBe(false)
    expect(getFilesSnapshot().has('C:/wiki/dnd/root-note.md')).toBe(false)

    // Verify open doc.md buffer/tab path synced to new location
    expect(screen.getByText('C:/wiki/dnd/dest/doc.md')).toBeInTheDocument()

    // 2. Hovering collapsed 'dest' folder with dragged 'pic1.png' auto-expands after 500ms
    fireEvent.click(within(pic1Item).getByText('pic1.png'), { ctrlKey: true })
    // Select pic1.png alone via Ctrl+click toggle or drag directly without opening image preview tab
    await user.click(treeEl)
    fireEvent.click(within(pic1Item).getByText('pic1.png'), { ctrlKey: true })
    vi.useFakeTimers()
    try {
      const dtAutoExpand = createTreeDataTransfer()
      fireEvent.dragStart(pic1Item, { dataTransfer: dtAutoExpand })
      fireEvent.dragOver(destFolder, { dataTransfer: dtAutoExpand })
      expect(destFolder).toHaveAttribute('aria-expanded', 'false')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(destFolder).toHaveAttribute('aria-expanded', 'true')
      fireEvent.dragEnd(pic1Item, { dataTransfer: dtAutoExpand })
    } finally {
      vi.useRealTimers()
    }

    // 3. Dropping onto a file row inside 'dest' ('dest/existing.md') moves into 'dest',
    // and dropping onto empty tree area moves back to workspace root
    const movedDocItem = await within(destFolder).findByRole('treeitem', { name: 'doc.md' })
    const destExistingItem = within(destFolder).getByRole('treeitem', { name: 'existing.md' })

    const dtToFileParent = createTreeDataTransfer()
    fireEvent.dragStart(pic1Item, { dataTransfer: dtToFileParent })
    fireEvent.dragOver(destExistingItem, { dataTransfer: dtToFileParent })
    expect(destFolder.querySelector('.tree-row')).toHaveClass('is-drop-target')
    fireEvent.drop(destExistingItem, { dataTransfer: dtToFileParent })
    fireEvent.dragEnd(pic1Item, { dataTransfer: dtToFileParent })
    await waitFor(() => {
      expect(getFilesSnapshot().has('C:/wiki/dnd/dest/pic1.png')).toBe(true)
    })

    // Move movedDocItem back to workspace root by dropping on ul.folder-tree
    const dtToRoot = createTreeDataTransfer()
    fireEvent.dragStart(movedDocItem, { dataTransfer: dtToRoot })
    fireEvent.dragOver(treeEl, { dataTransfer: dtToRoot })
    expect(treeEl).toHaveClass('is-root-drop-target')
    expect(treeEl).toHaveAttribute('data-drop-target', 'root')
    fireEvent.drop(treeEl, { dataTransfer: dtToRoot })
    fireEvent.dragEnd(movedDocItem, { dataTransfer: dtToRoot })
    await waitFor(() => {
      expect(getFilesSnapshot().has('C:/wiki/dnd/doc.md')).toBe(true)
    })
    expect(screen.getByText('C:/wiki/dnd/doc.md')).toBeInTheDocument()

    // 4. All-or-Nothing conflict check when moving multiple items into 'dest' where 'existing.md' collides
    await user.click(within(conflictFolder).getByText('conflict'))
    const conflictExistingInConflict = await within(conflictFolder).findByRole('treeitem', {
      name: 'existing.md'
    })
    const conflictClean = within(conflictFolder).getByRole('treeitem', { name: 'clean.md' })
    await user.click(treeEl)
    fireEvent.click(within(conflictExistingInConflict).getByText('existing.md'), { ctrlKey: true })
    fireEvent.click(within(conflictClean).getByText('clean.md'), { ctrlKey: true })

    const dtConflict = createTreeDataTransfer()
    fireEvent.dragStart(conflictExistingInConflict, { dataTransfer: dtConflict })
    fireEvent.dragOver(destFolder, { dataTransfer: dtConflict })
    fireEvent.drop(destFolder, { dataTransfer: dtConflict })
    fireEvent.dragEnd(conflictExistingInConflict, { dataTransfer: dtConflict })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/이미 존재/)
    expect(getFilesSnapshot().has('C:/wiki/dnd/conflict/clean.md')).toBe(true)
    expect(getFilesSnapshot().has('C:/wiki/dnd/dest/clean.md')).toBe(false)
    expect(conflictExistingInConflict).toBeInTheDocument()

    // 5. Multi-selecting multiple images (pic1.png in dest + pic2.webp in src) and dropping into Raw editor inserts all images
    const movedPic1 = within(destFolder).getByRole('treeitem', { name: 'pic1.png' })
    await user.click(treeEl)
    fireEvent.click(within(movedPic1).getByText('pic1.png'), { ctrlKey: true })
    fireEvent.click(within(pic2Item).getByText('pic2.webp'), { ctrlKey: true })

    const dtImages = createTreeDataTransfer()
    fireEvent.dragStart(movedPic1, { dataTransfer: dtImages })
    fireEvent.drop(rawEditor, { dataTransfer: dtImages })
    fireEvent.dragEnd(movedPic1, { dataTransfer: dtImages })

    await waitFor(() => {
      const text = getRawEditorText(rawEditor)
      expect(text).toContain('![pic1](./dest/pic1.png)')
      expect(text).toContain('![pic2](./src/pic2.webp)')
    })
  })

  it('includes drop target highlight styles in theme.css', () => {
    expect(themeCss).toContain('.tree-row.is-drop-target')
    expect(themeCss).toContain('.folder-tree.is-root-drop-target')
  })
})

