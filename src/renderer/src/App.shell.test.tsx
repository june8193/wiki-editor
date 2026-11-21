import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppConfig, cloneAppConfig, DEFAULT_APP_CONFIG } from '@shared/config'
import { createEmptyGitStatus, type GitFileStatusCode } from '@shared/git'
import type { RendererLogPayload } from '@shared/logging'
import { App } from './App'
import { clickActivityBarButton, switchPaneEditorMode } from './test/appTestHelpers'
import { mountThemeStylesAndRoot } from './test/domLayoutStub'
import {
  appendRawEditorText,
  createInMemoryWikiApi,
  getRawEditorScroller,
  getRawEditorText,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

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
    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Pull' }))
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
    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Push' }))
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
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    await switchPaneEditorMode(user, primaryPane, 'Preview')
    await switchPaneEditorMode(user, primaryPane, 'Raw')

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
    expect(within(workspaceView).getByRole('button', { name: /^gamma$/i })).toBeInTheDocument()
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

    // Switch to Git view -> Git state & branch picker work, stage notes.md
    const statusCallsBeforeSwitch = gitStatusSpy.mock.calls.length
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: '현재 브랜치 main' }))
    const branchMenu = within(gitRegion).getByRole('menu', { name: '브랜치 선택' })
    expect(
      within(branchMenu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['main', 'feature/sidebar'])
    await user.keyboard('{Escape}')
    expect(within(gitRegion).queryByRole('menu', { name: '브랜치 선택' })).not.toBeInTheDocument()

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
      await switchPaneEditorMode(user, primaryPane, '위지윅')
      assertPaneIsolation(primaryPane, 'wysiwyg')

      // Switch to Preview mode in single pane
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      assertPaneIsolation(primaryPane, 'preview')

      // Open second file and split horizontally (좌우 분할)
      await user.click(within(explorer).getByText('long-b.md'))
      const secondTab = within(primaryPane).getByRole('tab', { name: /long-b\.md/i })
      fireEvent.dragStart(secondTab)
      fireEvent.drop(await screen.findByTestId('split-drop-zone-horizontal'))
      expect(paneWorkspace).toHaveAttribute('data-split-mode', 'horizontal')

      const secondaryPane = screen.getByRole('region', { name: '보조 편집기 영역' })
      await switchPaneEditorMode(user, secondaryPane, '위지윅')
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
      const gitTitle = within(gitPanel).getByText('Source Control')
      expect(gitTitle.closest('button')).toBeNull()
      const gitHeader = gitTitle.closest('.git-header') as HTMLElement
      expect(
        within(gitHeader).getByRole('button', { name: 'Git 상태 새로고침' })
      ).not.toHaveAttribute('aria-expanded')
      expect(gitPanel.querySelector('.git-common-area')).toBeNull()
      const gitBranchSubrow = gitPanel.querySelector('.git-branch-subrow') as HTMLElement
      expect(getComputedStyle(gitBranchSubrow).flexShrink).toBe('0')
      expect(getComputedStyle(gitBranchSubrow).height).toBe('26px')
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

      await user.click(within(gitPanel).getByRole('button', { name: '현재 브랜치 main' }))
      await user.click(within(gitPanel).getByRole('menuitem', { name: 'feature/layout' }))
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

  it('opens the embedded user manual modal via open-manual menu command, coordinates with settings, and closes on 닫기 or Escape', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({})
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-manual')

    const manualDialog = await screen.findByRole('dialog', { name: '사용자 매뉴얼' })
    expect(within(manualDialog).getByRole('navigation', { name: '매뉴얼 목차' })).toHaveTextContent(
      '단축키 모음'
    )
    expect(within(manualDialog).getByTestId('manual-markdown-preview')).toHaveTextContent(
      'Ctrl+Shift+F'
    )

    // Opening settings closes the manual modal
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(screen.queryByRole('dialog', { name: '사용자 매뉴얼' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    // Opening manual closes settings
    await triggerMenuCommand(emitMenuCommand, 'open-manual')
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '사용자 매뉴얼' })).toBeInTheDocument()

    // Closes on Escape
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '사용자 매뉴얼' })).not.toBeInTheDocument()

    // Reopen and close via 닫기 button
    await triggerMenuCommand(emitMenuCommand, 'open-manual')
    await user.click(
      within(screen.getByRole('dialog', { name: '사용자 매뉴얼' })).getByRole('button', {
        name: '닫기'
      })
    )
    expect(screen.queryByRole('dialog', { name: '사용자 매뉴얼' })).not.toBeInTheDocument()
  })
})
