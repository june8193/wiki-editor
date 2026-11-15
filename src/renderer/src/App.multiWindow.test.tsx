import { fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import {
  createMultiWindowWikiHarness,
  getRawEditorText,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, text: string) => ({
      svg: `<svg data-code="${text.trim()}"><text>DiagramOK</text></svg>`
    }))
  }
}))

async function openFolderAndNoteInWindow(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  emitMenuCommand: (command: 'open-folder' | 'toggle-theme' | 'toggle-settings') => void,
  fileName: string
): Promise<HTMLElement> {
  await triggerMenuCommand(emitMenuCommand, 'open-folder')
  const sidebar = await within(container).findByLabelText('워크스페이스 탐색기')
  await user.click(await within(sidebar).findByText(fileName))
  return within(container).findByTestId('document-editor')
}

describe('Multi-window shared document buffer integration (<App />)', () => {
  const activeDisposers: Array<() => void> = []

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  afterEach(() => {
    for (const dispose of activeDisposers.splice(0)) {
      dispose()
    }
  })

  it('syncs workspace document edits, dirty badges, header save status, and saves in real time between two windows', async () => {
    const user = userEvent.setup()
    const harness = createMultiWindowWikiHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'shared.md': '# Original'
          }
        }
      }
    )
    activeDisposers.push(() => harness.dispose())

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    // Window 1 opens shared.md and edits before Window 2 opens it
    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'shared.md'
    )
    setRawEditorText(editor1, '# Draft from Window 1')

    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Window 2 opens the same note and sees Window 1's unsaved content, ● badge, and 미저장 status immediately
    const editor2 = await openFolderAndNoteInWindow(
      user,
      rendered2.container,
      win2.emitMenuCommand,
      'shared.md'
    )
    expect(getRawEditorText(editor2)).toBe('# Draft from Window 1')
    expect(within(rendered2.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(within(rendered2.container).getByText('미저장')).toBeInTheDocument()

    // Edits in Window 2 propagate back to Window 1 in real time
    setRawEditorText(editor2, '# Edited in Window 2')
    await waitFor(() => {
      expect(getRawEditorText(editor1)).toBe('# Edited in Window 2')
    })

    // Manual save (Ctrl+S) in Window 1 saves disk and clears ● / sets 저장됨 in BOTH windows
    fireEvent.keyDown(editor1, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(harness.getFilesSnapshot().get('C:/wiki/docs/shared.md')).toBe('# Edited in Window 2')
      expect(within(rendered1.container).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(within(rendered2.container).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(within(rendered1.container).getByText('저장됨')).toBeInTheDocument()
      expect(within(rendered2.container).getByText('저장됨')).toBeInTheDocument()
    })
  })

  it('skips unsaved confirmation when another window still holds the buffer and prompts only on the last remaining tab', async () => {
    const user = userEvent.setup()
    const harness = createMultiWindowWikiHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'alpha.md': 'Disk original'
          }
        }
      }
    )
    activeDisposers.push(() => harness.dispose())

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'alpha.md'
    )
    await openFolderAndNoteInWindow(user, rendered2.container, win2.emitMenuCommand, 'alpha.md')

    setRawEditorText(editor1, 'Unsaved edit across windows')

    await waitFor(() => {
      expect(within(rendered2.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Wait until hub tab count reflects both windows, then close tab in Window 2 without confirmation
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/alpha.md']).toBe(2)
    })

    const closeBtnWin2 = within(rendered2.container).getByRole('button', { name: 'alpha.md 탭 닫기' })
    await user.click(closeBtnWin2)

    expect(within(rendered2.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(rendered2.container).queryByRole('tab', { name: /alpha\.md/ })).not.toBeInTheDocument()

    // Window 1 still retains the dirty draft
    expect(getRawEditorText(editor1)).toBe('Unsaved edit across windows')
    expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Wait until hub reflects Window 1 holding the sole remaining tab, then closing triggers ConfirmDialog
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/alpha.md']).toBe(1)
    })

    const closeBtnWin1 = within(rendered1.container).getByRole('button', { name: 'alpha.md 탭 닫기' })
    await user.click(closeBtnWin1)

    const dialog = await within(rendered1.container).findByRole('alertdialog')
    expect(dialog).toBeInTheDocument()

    // Discarding removes buffer from Hub so disk content isn't modified and reopening reads original
    await user.click(within(dialog).getByRole('button', { name: '버리고 닫기' }))
    await waitFor(() => {
      expect(within(rendered1.container).queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(Object.keys(harness.hub.getSnapshot().buffers)).toHaveLength(0)
    })

    const sidebar1 = within(rendered1.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar1).findByText('alpha.md'))
    const reopenedEditor1 = await within(rendered1.container).findByTestId('document-editor')
    expect(getRawEditorText(reopenedEditor1)).toBe('Disk original')
  })

  it('shares config.json buffer edits, validation errors, and persistence across windows', async () => {
    const user = userEvent.setup()
    const harness = createMultiWindowWikiHarness({ theme: 'light', autoSave: false })
    activeDisposers.push(() => harness.dispose())

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    // Open config.json in Window 1
    await triggerMenuCommand(win1.emitMenuCommand, 'toggle-settings')
    await user.click(
      await within(rendered1.container).findByRole('button', { name: '설정 파일 직접 열기' })
    )
    const configEditor1 = await within(rendered1.container).findByTestId('document-editor')
    setRawEditorText(configEditor1, '{invalid json')

    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Open config.json in Window 2 -> sees Window 1's unsaved invalid draft + ● indicator
    await triggerMenuCommand(win2.emitMenuCommand, 'toggle-settings')
    await user.click(
      await within(rendered2.container).findByRole('button', { name: '설정 파일 직접 열기' })
    )
    const configEditor2 = await within(rendered2.container).findByTestId('document-editor')
    expect(getRawEditorText(configEditor2)).toBe('{invalid json')
    expect(within(rendered2.container).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Saving invalid JSON from Window 2 shows validation alert and preserves dirty state
    fireEvent.keyDown(configEditor2, { key: 's', ctrlKey: true })
    expect(await within(rendered2.container).findByRole('alert')).toBeInTheDocument()
    expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Save valid JSON from Window 2 -> clears ● in BOTH windows and applies theme/autoSave config
    const validRaw = JSON.stringify(
      {
        ...(await win1.api.config.get()),
        theme: 'dark',
        autoSave: true
      },
      null,
      2
    )
    setRawEditorText(configEditor2, validRaw)
    await waitFor(() => {
      expect(getRawEditorText(configEditor1)).toBe(validRaw)
    })

    fireEvent.keyDown(configEditor2, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(within(rendered1.container).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(within(rendered2.container).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(within(rendered1.container).getByText('저장됨')).toBeInTheDocument()
      expect(within(rendered2.container).getByText('저장됨')).toBeInTheDocument()
    })
    expect((await win1.api.config.get()).theme).toBe('dark')
    expect((await win2.api.config.get()).autoSave).toBe(true)
  })

  it('syncs file rename, file deletion, and external disk reconciliation across windows', async () => {
    const user = userEvent.setup()
    const harness = createMultiWindowWikiHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'first.md': '# First',
            'second.md': '# Second',
            'clean.md': '# Clean before'
          }
        }
      }
    )
    activeDisposers.push(() => harness.dispose())

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    // Open all three files in Window 2 and first.md in Window 1
    await openFolderAndNoteInWindow(user, rendered1.container, win1.emitMenuCommand, 'first.md')
    await openFolderAndNoteInWindow(user, rendered2.container, win2.emitMenuCommand, 'first.md')
    const sidebar2 = within(rendered2.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar2).findByText('second.md'))
    await user.click(await within(sidebar2).findByText('clean.md'))

    // Switch Window 2 back to first.md and edit dirty
    await user.click(within(rendered2.container).getByRole('tab', { name: /first\.md/ }))
    const editor2 = await within(rendered2.container).findByTestId('document-editor')
    setRawEditorText(editor2, '# Unsaved first')

    // Rename first.md -> renamed.md in Window 1
    const sidebar1 = within(rendered1.container).getByLabelText('워크스페이스 탐색기')
    const firstItem = within(sidebar1).getByRole('treeitem', { name: 'first.md' })
    firstItem.focus()
    fireEvent.keyDown(firstItem, { key: 'F2' })
    const renameInput = await within(sidebar1).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'renamed.md{Enter}')

    await waitFor(() => {
      expect(within(rendered2.container).getByRole('tab', { name: /renamed\.md/ })).toBeInTheDocument()
      expect(within(rendered2.container).queryByRole('tab', { name: /first\.md/ })).not.toBeInTheDocument()
    })
    expect(getRawEditorText(editor2)).toBe('# Unsaved first')

    // Delete second.md in Window 1 -> closes second.md tab in Window 2
    const secondItem = within(sidebar1).getByRole('treeitem', { name: 'second.md' })
    fireEvent.contextMenu(secondItem)
    await user.click(await within(rendered1.container).findByRole('menuitem', { name: '삭제' }))
    const deleteDialog = await within(rendered1.container).findByRole('alertdialog')
    await user.click(within(deleteDialog).getByRole('button', { name: '삭제 확인' }))

    await waitFor(() => {
      expect(within(rendered2.container).queryByRole('tab', { name: /second\.md/ })).not.toBeInTheDocument()
    })

    // External disk update on clean.md refreshes clean buffer in Window 2 (and Window 1)
    await user.click(within(rendered2.container).getByRole('tab', { name: /clean\.md/ }))
    await win1.api.workspace.writeFile('C:/wiki/docs/clean.md', '# Updated on disk')
    harness.emitWorkspaceChange({
      rootPath: 'C:/wiki/docs',
      eventType: 'change',
      relativePath: 'clean.md'
    })

    await waitFor(() => {
      expect(getRawEditorText(within(rendered2.container).getByTestId('document-editor'))).toBe(
        '# Updated on disk'
      )
    })
  })

  it('performs a single deduplicated autoSave write when a dirty document is open in multiple windows', async () => {
    const user = userEvent.setup()
    const harness = createMultiWindowWikiHarness(
      { autoSave: true, autoSaveDelayMs: 50, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'auto.md': '# Initial'
          }
        }
      }
    )
    activeDisposers.push(() => harness.dispose())

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()
    const writeSpy = vi.spyOn(win1.api.workspace, 'writeFile')

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'auto.md'
    )
    const editor2 = await openFolderAndNoteInWindow(
      user,
      rendered2.container,
      win2.emitMenuCommand,
      'auto.md'
    )

    setRawEditorText(editor1, '# Single unified autoSave')
    await waitFor(() => {
      expect(within(rendered1.container).getByText('자동 저장 대기')).toBeInTheDocument()
      expect(within(rendered2.container).getByText('자동 저장 대기')).toBeInTheDocument()
    })

    await waitFor(
      () => {
        expect(harness.getFilesSnapshot().get('C:/wiki/docs/auto.md')).toBe(
          '# Single unified autoSave'
        )
        expect(within(rendered1.container).getByText('저장됨')).toBeInTheDocument()
        expect(within(rendered2.container).getByText('저장됨')).toBeInTheDocument()
      },
      { timeout: 2000 }
    )

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(getRawEditorText(editor2)).toBe('# Single unified autoSave')
  })

  it('cleans up destroyed window tab references so remaining window prompts on last dirty tab close', async () => {
    const user = userEvent.setup()
    const harness = createMultiWindowWikiHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'destroy.md': '# Initial'
          }
        }
      }
    )
    activeDisposers.push(() => harness.dispose())

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'destroy.md'
    )
    await openFolderAndNoteInWindow(user, rendered2.container, win2.emitMenuCommand, 'destroy.md')

    setRawEditorText(editor1, '# Edited before win2 destroyed')
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/destroy.md']).toBe(2)
    })

    // Simulate OS window destruction of Window 2
    win2.destroy()
    rendered2.unmount()

    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/destroy.md']).toBe(1)
    })
    expect(getRawEditorText(editor1)).toBe('# Edited before win2 destroyed')

    await user.click(within(rendered1.container).getByRole('button', { name: 'destroy.md 탭 닫기' }))
    expect(await within(rendered1.container).findByRole('alertdialog')).toBeInTheDocument()
  })
})
