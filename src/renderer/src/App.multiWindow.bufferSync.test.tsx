import { fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { addFavoriteWorkspace } from '@shared/workspace'
import { App } from './App'
import { getRawEditorText, setRawEditorText, triggerMenuCommand } from './test/inMemoryWikiHarness'
import {
  deferBufferMethod,
  openConfigFromSettings,
  openFolderAndNoteInWindow,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('Multi-window shared document buffer integration (<App />)', () => {
  const { createHarness } = registerMultiWindowLifecycle()

  it('syncs workspace document edits, dirty badges, header save status, and saves in real time between two windows', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
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

    // Manual save (Ctrl+S) in Window 1 syncs 저장 중... in BOTH windows, then saves disk and sets 저장됨
    const origWriteFile = win1.api.workspace.writeFile.bind(win1.api.workspace)
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    win1.api.workspace.writeFile = async (filePath, content) => {
      await writeGate
      return origWriteFile(filePath, content)
    }

    fireEvent.keyDown(editor1, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(within(rendered1.container).getByText('저장 중...')).toBeInTheDocument()
      expect(within(rendered2.container).getByText('저장 중...')).toBeInTheDocument()
    })

    win1.api.workspace.writeFile = origWriteFile
    releaseWrite()

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
    const harness = createHarness(
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
    const harness = createHarness({ theme: 'light', autoSave: false })

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    // Open config.json in Window 1
    await openConfigFromSettings(user, rendered1.container, win1.emitMenuCommand)
    const configEditor1 = await within(rendered1.container).findByTestId('document-editor')
    setRawEditorText(configEditor1, '{invalid json')

    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Open config.json in Window 2 -> sees Window 1's unsaved invalid draft + ● indicator
    await openConfigFromSettings(user, rendered2.container, win2.emitMenuCommand)
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
    const harness = createHarness(
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
    const harness = createHarness(
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
    const harness = createHarness(
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

  it('routes edits and saves to a recreated file instead of the previously renamed buffer', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'a.md': '# Original A'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const rendered1 = render(<App wikiApi={win1.api} />)

    await openFolderAndNoteInWindow(user, rendered1.container, win1.emitMenuCommand, 'a.md')

    // Rename a.md -> b.md
    const sidebar = within(rendered1.container).getByLabelText('워크스페이스 탐색기')
    const itemA = within(sidebar).getByRole('treeitem', { name: 'a.md' })
    itemA.focus()
    fireEvent.keyDown(itemA, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'b.md{Enter}')

    await waitFor(() => {
      expect(within(rendered1.container).getByRole('tab', { name: /b\.md/ })).toBeInTheDocument()
    })

    // Recreate a.md and wait for its new tab to become active before editing + saving it
    await user.click(within(sidebar).getByRole('button', { name: /새 파일/i }))
    await user.type(await within(sidebar).findByLabelText('새 파일 이름'), 'a.md{Enter}')

    const tabA = await within(rendered1.container).findByRole('tab', { name: /a\.md/ })
    await waitFor(() => {
      expect(tabA).toHaveAttribute('aria-selected', 'true')
    })

    const editorA = await within(rendered1.container).findByTestId('document-editor')
    expect(getRawEditorText(editorA)).toBe('')
    setRawEditorText(editorA, '# Brand new A')
    await waitFor(() => {
      expect(within(rendered1.container).getByText('미저장')).toBeInTheDocument()
    })

    await user.click(within(rendered1.container).getByRole('button', { name: '저장' }))

    await waitFor(() => {
      expect(within(rendered1.container).getByText('저장됨')).toBeInTheDocument()
    })

    expect(harness.getFilesSnapshot().get('C:/wiki/docs/a.md')).toBe('# Brand new A')
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/b.md')).toBe('# Original A')
  })

  it('prompts before closing the last remaining pane of a dirty split document even while syncWindowTabs is pending', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'split.md': '# Initial'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const rendered1 = render(<App wikiApi={win1.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'split.md'
    )

    // Duplicate split.md into the secondary pane
    fireEvent.contextMenu(within(rendered1.container).getByRole('tab', { name: /split\.md/ }))
    await user.click(
      await within(rendered1.container).findByRole('menuitem', { name: '분할 영역에 복제 열기' })
    )
    await waitFor(() => {
      expect(within(rendered1.container).getAllByRole('button', { name: 'split.md 탭 닫기' })).toHaveLength(
        2
      )
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/split.md']).toBe(2)
    })

    setRawEditorText(editor1, '# Unsaved split edits')
    await waitFor(() => {
      expect(within(rendered1.container).getAllByTestId('dirty-indicator').length).toBeGreaterThanOrEqual(
        1
      )
    })

    // Hold the next syncWindowTabs IPC call unresolved while closing both split panes rapidly
    const syncGate = deferBufferMethod(win1.api.buffer, 'syncWindowTabs')

    const closeButtonsBeforeFirst = within(rendered1.container).getAllByRole('button', {
      name: 'split.md 탭 닫기'
    })
    await user.click(closeButtonsBeforeFirst[0])

    expect(within(rendered1.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    const closeButtonsBeforeSecond = within(rendered1.container).getAllByRole('button', {
      name: 'split.md 탭 닫기'
    })
    expect(closeButtonsBeforeSecond).toHaveLength(1)

    // Closing the remaining local pane while syncWindowTabs is still unresolved must prompt
    await user.click(closeButtonsBeforeSecond[0])
    expect(within(rendered1.container).getByRole('alertdialog')).toBeInTheDocument()

    syncGate.flushAll()
  })

  it('re-acquires shared buffers through the hub when opening in a second window races with closing in the first', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'race.md': '# From Disk'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()

    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    await openFolderAndNoteInWindow(user, rendered1.container, win1.emitMenuCommand, 'race.md')
    await triggerMenuCommand(win2.emitMenuCommand, 'open-folder')
    const sidebar2 = await within(rendered2.container).findByLabelText('워크스페이스 탐색기')

    // Hold Window 2's syncWindowTabs so Window 1 closes its last tab before Window 2 syncs
    const openSpy = vi.spyOn(win2.api.buffer, 'openWorkspaceFile')
    const win2SyncGate = deferBufferMethod(win2.api.buffer, 'syncWindowTabs')

    await user.click(await within(sidebar2).findByText('race.md'))
    await waitFor(() => {
      expect(within(rendered2.container).getByRole('tab', { name: /race\.md/ })).toBeInTheDocument()
    })

    // Window 1 closes its clean tab before Window 2's syncWindowTabs settles
    await user.click(within(rendered1.container).getByRole('button', { name: 'race.md 탭 닫기' }))
    await waitFor(() => {
      expect(within(rendered1.container).queryByRole('tab', { name: /race\.md/ })).not.toBeInTheDocument()
    })

    win2SyncGate.flushAll()

    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/race.md']).toBe(1)
    })

    expect(openSpy).toHaveBeenCalledWith('C:/wiki/docs/race.md', 'race.md')
    const editor2 = await within(rendered2.container).findByTestId('document-editor')
    expect(getRawEditorText(editor2)).toBe('# From Disk')
  })

  it('flushes pending updateContent edits before saving on 저장 후 닫기 when the hub snapshot is still clean', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'draft.md': '# Initial'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const rendered1 = render(<App wikiApi={win1.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'draft.md'
    )
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/draft.md']).toBe(1)
    })

    // Hold bufferApi.updateContent unresolved so latestHubBuffers still reports isDirty === false
    const editGate = deferBufferMethod(win1.api.buffer, 'updateContent')

    setRawEditorText(editor1, '# Flushed before close')
    expect(editGate.count()).toBe(1)
    expect(harness.hub.getSnapshot().buffers['c:/wiki/docs/draft.md']?.isDirty).toBe(false)

    await user.click(within(rendered1.container).getByRole('button', { name: 'draft.md 탭 닫기' }))
    const dialog = await within(rendered1.container).findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '저장 후 닫기' }))

    // Flush the in-flight edit after saveAndCloseTab has started
    editGate.flushAll()

    await waitFor(() => {
      expect(within(rendered1.container).queryByRole('tab', { name: /draft\.md/ })).not.toBeInTheDocument()
    })
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/draft.md')).toBe('# Flushed before close')
  })

  it('flushes pending updateContent edits before saving on 저장 후 이동 when switching workspaces', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace(
      [],
      'C:/wiki/next',
      'next',
      '2026-11-14T00:00:00.000Z'
    )
    const harness = createHarness(
      { autoSave: false, theme: 'light', favoriteWorkspaces: favorites },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'note.md': '# Initial'
          },
          'C:\\wiki\\next': {
            'next.md': '# Next'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const rendered1 = render(<App wikiApi={win1.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'note.md'
    )
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/note.md']).toBe(1)
    })

    const editGate = deferBufferMethod(win1.api.buffer, 'updateContent')

    setRawEditorText(editor1, '# Flushed before workspace switch')
    expect(editGate.count()).toBe(1)

    const activityBar = within(rendered1.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar).getByRole('button', { name: '워크스페이스' }))
    const workspaceView = within(rendered1.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*next/i }))

    const dialog = await within(rendered1.container).findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /저장 후 이동/i }))

    editGate.flushAll()

    const updatedSidebar = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(updatedSidebar).findByText('next.md')).toBeInTheDocument()
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/note.md')).toBe(
      '# Flushed before workspace switch'
    )
  })

  it('prompts when closing a dirty shared document if another window closes it while syncWindowTabs is pending', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'shared.md': '# Shared',
            'other.md': '# Other'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()
    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'shared.md'
    )
    await openFolderAndNoteInWindow(user, rendered2.container, win2.emitMenuCommand, 'shared.md')
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/shared.md']).toBe(2)
    })

    setRawEditorText(editor1, '# Unsaved shared edits')
    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Hold Window 1's syncWindowTabs in flight while Window 2 closes shared.md
    const sidebar1 = within(rendered1.container).getByLabelText('워크스페이스 탐색기')
    const win1SyncGate = deferBufferMethod(win1.api.buffer, 'syncWindowTabs')
    await user.click(within(sidebar1).getByText('other.md'))
    await waitFor(() => {
      expect(within(rendered1.container).getByRole('tab', { name: /other\.md/ })).toBeInTheDocument()
      expect(win1SyncGate.count()).toBeGreaterThanOrEqual(1)
    })

    await user.click(within(rendered2.container).getByRole('button', { name: 'shared.md 탭 닫기' }))
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/shared.md']).toBe(1)
    })

    // Window 1 now holds the sole remaining reference and must prompt even before syncWindowTabs settles
    await user.click(within(rendered1.container).getByRole('button', { name: 'shared.md 탭 닫기' }))
    const dialog = await within(rendered1.container).findByRole('alertdialog')
    expect(dialog).toBeInTheDocument()

    win1SyncGate.flushAll()
  })

  it('ignores stale syncWindowTabs responses after a newer cross-window close event reduces tabCounts to 1', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'shared.md': '# Shared',
            'other.md': '# Other'
          }
        }
      }
    )

    const win1 = harness.createWindow()
    const win2 = harness.createWindow()
    const rendered1 = render(<App wikiApi={win1.api} />)
    const rendered2 = render(<App wikiApi={win2.api} />)

    const editor1 = await openFolderAndNoteInWindow(
      user,
      rendered1.container,
      win1.emitMenuCommand,
      'shared.md'
    )
    await openFolderAndNoteInWindow(user, rendered2.container, win2.emitMenuCommand, 'shared.md')
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/shared.md']).toBe(2)
    })

    setRawEditorText(editor1, '# Unsaved after remote close')
    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Execute syncWindowTabs on the hub immediately (capturing tabCounts = 2), but delay returning its reply
    const origSync = win1.api.buffer.syncWindowTabs.bind(win1.api.buffer)
    const releaseReplies: Array<() => void> = []
    win1.api.buffer.syncWindowTabs = async (bufferKeys) => {
      const snapshot = await origSync(bufferKeys)
      return new Promise((resolve) => {
        releaseReplies.push(() => resolve(snapshot))
      })
    }

    const sidebar1 = within(rendered1.container).getByLabelText('워크스페이스 탐색기')
    await user.click(within(sidebar1).getByText('other.md'))
    await waitFor(() => {
      expect(releaseReplies.length).toBeGreaterThanOrEqual(1)
    })

    // Window 2 closes shared.md AFTER Window 1's hub update ran, broadcasting count = 1
    await user.click(within(rendered2.container).getByRole('button', { name: 'shared.md 탭 닫기' }))
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/shared.md']).toBe(1)
    })

    // Now the stale syncWindowTabs reply (which still saw count = 2) settles in Window 1
    win1.api.buffer.syncWindowTabs = origSync
    for (const release of releaseReplies.splice(0)) {
      release()
    }
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/shared.md']).toBe(1)
    })

    await user.click(within(rendered1.container).getByRole('button', { name: 'shared.md 탭 닫기' }))
    expect(await within(rendered1.container).findByRole('alertdialog')).toBeInTheDocument()
  })
})
