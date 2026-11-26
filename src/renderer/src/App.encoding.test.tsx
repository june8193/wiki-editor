import { fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { getRawEditorText, setRawEditorText } from './test/inMemoryWikiHarness'
import {
  openConfigFromSettings,
  openFolderAndNoteInWindow,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('Encoding UI, Confirm Dialogs, Error Banner & Multi-Window Sync (<App />)', () => {
  const { createHarness } = registerMultiWindowLifecycle()

  it('displays encoding in editor header, hides on image tabs, locks config.json & frontmatter.json, converts encoding with dirty badge, and guards dirty reopen with ConfirmDialog', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'note.md': '안녕하세요',
            'pic.png': '',
            '.wiki-editor/frontmatter.json': '{"version":1,"fields":[]}'
          }
        },
        workspacesEncoding: {
          'C:\\wiki\\docs': {
            'note.md': 'euc-kr'
          }
        }
      }
    )

    const win = harness.createWindow()
    const { container } = render(<App wikiApi={win.api} />)

    // 1. Open EUC-KR note.md -> header shows EUC-KR
    const editor = await openFolderAndNoteInWindow(user, container, win.emitMenuCommand, 'note.md')
    expect(getRawEditorText(editor)).toBe('안녕하세요')
    const encodingBtn = within(container).getByRole('button', { name: /문서 인코딩/ })
    expect(encodingBtn).toHaveTextContent('EUC-KR')
    expect(encodingBtn).toBeEnabled()

    // 2. Convert encoding EUC-KR -> UTF-8: content stays intact, dirty badge appears, save writes UTF-8
    await user.click(encodingBtn)
    const convertGroup = within(within(container).getByRole('menu', { name: '인코딩 메뉴' })).getByRole(
      'group',
      { name: '인코딩 변경' }
    )
    await user.click(within(convertGroup).getByRole('menuitem', { name: /UTF-8/ }))

    await waitFor(() => {
      expect(within(container).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent('UTF-8')
      expect(within(container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })
    expect(getRawEditorText(editor)).toBe('안녕하세요')

    await user.click(within(container).getByRole('button', { name: '저장' }))
    await waitFor(() => {
      expect(within(container).queryByTestId('dirty-indicator')).toBeNull()
    })
    expect(harness.getFileEncoding('C:/wiki/docs/note.md')).toBe('utf-8')

    // 3. Edit note.md (dirty), then choose "인코딩으로 다시 열기" -> ConfirmDialog warns about unsaved changes
    setRawEditorText(editor, '수정된 미저장 내용')
    await waitFor(() => {
      expect(within(container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    await user.click(within(container).getByRole('button', { name: /문서 인코딩/ }))
    const reopenGroup = within(within(container).getByRole('menu', { name: '인코딩 메뉴' })).getByRole(
      'group',
      { name: '인코딩으로 다시 열기' }
    )
    await user.click(within(reopenGroup).getByRole('menuitem', { name: /EUC-KR/ }))

    const dialog = await within(container).findByRole('alertdialog')
    expect(within(dialog).getByText(/저장하지 않은 변경 사항/)).toBeInTheDocument()

    // Cancel -> keeps dirty edits and UTF-8
    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(within(container).queryByRole('alertdialog')).toBeNull()
    expect(getRawEditorText(editor)).toBe('수정된 미저장 내용')
    expect(within(container).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Confirm reopen -> discards dirty edits and re-decodes disk bytes as EUC-KR (note.md on disk is UTF-8 bytes of '안녕하세요')
    await user.click(within(container).getByRole('button', { name: /문서 인코딩/ }))
    const reopenGroup2 = within(
      within(container).getByRole('menu', { name: '인코딩 메뉴' })
    ).getByRole('group', { name: '인코딩으로 다시 열기' })
    await user.click(within(reopenGroup2).getByRole('menuitem', { name: /EUC-KR/ }))
    const dialog2 = await within(container).findByRole('alertdialog')
    await user.click(within(dialog2).getByRole('button', { name: '다시 열기' }))

    await waitFor(() => {
      expect(within(container).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent('EUC-KR')
      expect(within(container).queryByTestId('dirty-indicator')).toBeNull()
    })

    // 4. Image tab hides encoding button
    const sidebar = within(container).getByLabelText('워크스페이스 탐색기')
    await user.click(within(sidebar).getByText('pic.png'))
    await waitFor(() => {
      expect(within(container).queryByRole('button', { name: /문서 인코딩/ })).toBeNull()
    })

    // 5. config.json locks encoding button to UTF-8
    await openConfigFromSettings(user, container, win.emitMenuCommand)
    await waitFor(() => {
      const btn = within(container).getByRole('button', { name: /문서 인코딩/ })
      expect(btn).toHaveTextContent('UTF-8')
      expect(btn).toBeDisabled()
    })

    // 6. .wiki-editor/frontmatter.json locks encoding button to UTF-8
    await user.click(within(container).getByRole('button', { name: '스키마 관리' }))
    await user.click(await within(container).findByRole('button', { name: 'JSON 파일로 열기' }))
    await waitFor(() => {
      expect(within(container).getByRole('tab', { name: /frontmatter\.json/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      const btn = within(container).getByRole('button', { name: /문서 인코딩/ })
      expect(btn).toHaveTextContent('UTF-8')
      expect(btn).toBeDisabled()
    })
  })

  it('prompts ConfirmDialog on manual EUC-KR save with unencodable characters and saves "?" only when confirmed', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'euckr.md': '초기 본문'
          }
        },
        workspacesEncoding: {
          'C:\\wiki\\docs': {
            'euckr.md': 'euc-kr'
          }
        }
      }
    )

    const win = harness.createWindow()
    const { container } = render(<App wikiApi={win.api} />)

    const editor = await openFolderAndNoteInWindow(user, container, win.emitMenuCommand, 'euckr.md')
    setRawEditorText(editor, '안녕 😀')

    await waitFor(() => {
      expect(within(container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Manual save -> ConfirmDialog shows sample char '😀'
    await user.click(within(container).getByRole('button', { name: '저장' }))
    const dialog = await within(container).findByRole('alertdialog')
    expect(within(dialog).getByText(/😀/)).toBeInTheDocument()

    // Cancel -> keeps dirty state and disk untouched
    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(within(container).queryByRole('alertdialog')).toBeNull()
    expect(within(container).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/euckr.md')).toBe('초기 본문')

    // Retry manual save and confirm -> writes '?' replacement
    await user.click(within(container).getByRole('button', { name: '저장' }))
    const dialog2 = await within(container).findByRole('alertdialog')
    await user.click(within(dialog2).getByRole('button', { name: "'?'로 대체하여 저장" }))

    await waitFor(() => {
      expect(within(container).queryByTestId('dirty-indicator')).toBeNull()
    })
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/euckr.md')).toBe('안녕 ?')
    expect(harness.getFileEncoding('C:/wiki/docs/euckr.md')).toBe('euc-kr')
  })

  it('holds auto-save and displays ErrorBanner when EUC-KR document has unencodable characters', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: true, autoSaveDelayMs: 30, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'auto.md': '초기'
          }
        },
        workspacesEncoding: {
          'C:\\wiki\\docs': {
            'auto.md': 'euc-kr'
          }
        }
      }
    )

    const win = harness.createWindow()
    const { container } = render(<App wikiApi={win.api} />)

    const editor = await openFolderAndNoteInWindow(user, container, win.emitMenuCommand, 'auto.md')
    setRawEditorText(editor, '자동저장 😀')

    const alert = await within(container).findByRole('alert')
    expect(alert).toHaveTextContent(/EUC-KR 인코딩으로 표현할 수 없는 문자/)
    expect(alert).toHaveTextContent(/😀/)
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/auto.md')).toBe('초기')
    expect(within(container).getByTestId('dirty-indicator')).toBeInTheDocument()
  })

  it('syncs encoding conversion and reopen in real time across main window, auxiliary window, and split panes', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'sync.md': '동기화 테스트'
          }
        }
      }
    )

    const mainWin = harness.createWindow()
    const mainRendered = render(<App wikiApi={mainWin.api} />)

    await openFolderAndNoteInWindow(user, mainRendered.container, mainWin.emitMenuCommand, 'sync.md')

    // Duplicate tab to secondary split pane in main window
    fireEvent.contextMenu(within(mainRendered.container).getByRole('tab', { name: /sync\.md/ }))
    const tabMenu = await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    await waitFor(() => {
      expect(within(mainRendered.container).getByTestId('pane-secondary')).toBeInTheDocument()
    })

    // Detach secondary pane's tab to an auxiliary window
    const secondaryPane = within(mainRendered.container).getByTestId('pane-secondary')
    fireEvent.contextMenu(within(secondaryPane).getByRole('tab', { name: /sync\.md/ }))
    const secTabMenu = await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(secTabMenu).getByRole('menuitem', { name: '새 창으로 이동' }))

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(mainWin.windowId)).toHaveLength(1)
    })
    const auxWin = harness.getAuxiliaryWindows(mainWin.windowId)[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    await waitFor(() => {
      expect(within(auxRendered.container).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent(
        'UTF-8'
      )
    })

    // Also duplicate tab to secondary split pane in main window again so we test split pane + aux window simultaneously
    fireEvent.contextMenu(within(mainRendered.container).getByRole('tab', { name: /sync\.md/ }))
    const tabMenu2 = await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu2).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))
    await waitFor(() => {
      expect(within(mainRendered.container).getByTestId('pane-secondary')).toBeInTheDocument()
    })

    // Convert encoding to EUC-KR in main window primary pane -> secondary pane and aux window sync immediately
    const mainPrimary = within(mainRendered.container).getByTestId('pane-primary')
    await user.click(within(mainPrimary).getByRole('button', { name: /문서 인코딩/ }))
    const convertGroup = within(
      within(mainPrimary).getByRole('menu', { name: '인코딩 메뉴' })
    ).getByRole('group', { name: '인코딩 변경' })
    await user.click(within(convertGroup).getByRole('menuitem', { name: /EUC-KR/ }))

    await waitFor(() => {
      const mainSecondary = within(mainRendered.container).getByTestId('pane-secondary')
      expect(within(mainPrimary).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent('EUC-KR')
      expect(within(mainSecondary).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent(
        'EUC-KR'
      )
      expect(
        within(auxRendered.container).getByRole('button', { name: /문서 인코딩/ })
      ).toHaveTextContent('EUC-KR')
      expect(within(auxRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Reopen with UTF-8 from auxiliary window (dirty -> ConfirmDialog) -> main window panes sync back to UTF-8 & clean
    await user.click(within(auxRendered.container).getByRole('button', { name: /문서 인코딩/ }))
    const auxReopenGroup = within(
      within(auxRendered.container).getByRole('menu', { name: '인코딩 메뉴' })
    ).getByRole('group', { name: '인코딩으로 다시 열기' })
    await user.click(within(auxReopenGroup).getByRole('menuitem', { name: /UTF-8/ }))

    const auxDialog = await within(auxRendered.container).findByRole('alertdialog')
    await user.click(within(auxDialog).getByRole('button', { name: '다시 열기' }))

    await waitFor(() => {
      const mainSecondary = within(mainRendered.container).getByTestId('pane-secondary')
      expect(within(mainPrimary).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent('UTF-8')
      expect(within(mainSecondary).getByRole('button', { name: /문서 인코딩/ })).toHaveTextContent(
        'UTF-8'
      )
      expect(within(mainRendered.container).queryByTestId('dirty-indicator')).toBeNull()
      expect(within(auxRendered.container).queryByTestId('dirty-indicator')).toBeNull()
    })
  })
})
