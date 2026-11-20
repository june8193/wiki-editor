import { fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { App } from './App'
import { getRawEditorText, setRawEditorText, triggerMenuCommand } from './test/inMemoryWikiHarness'
import {
  detachTabViaContextMenu,
  openFolderAndNoteInWindow,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

const TEAM_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'status',
      label: '상태',
      type: 'select',
      required: true,
      options: [{ value: 'todo' }, { value: 'in-progress' }, { value: 'done' }]
    },
    { key: 'owner', label: '담당자', type: 'text' }
  ]
}

describe('Multi-window frontmatter right sidebar & shared buffer synchronization (<App />)', () => {
  const { createHarness } = registerMultiWindowLifecycle()

  it('provides 2-tier right sidebar accordion in auxiliary window and syncs frontmatter edits, dirty state, and saves in real time', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(TEAM_SCHEMA),
            'shared.md': '---\nstatus: todo\n---\n# Shared Title\n\nBody'
          }
        }
      }
    )

    const win1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={win1.api} />)

    await openFolderAndNoteInWindow(user, rendered1.container, win1.emitMenuCommand, 'shared.md')

    await detachTabViaContextMenu(user, rendered1.container, /shared\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(win1.windowId)).toHaveLength(1)
    })
    const auxWin = harness.getAuxiliaryWindows(win1.windowId)[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    const auxEditor = await within(auxRendered.container).findByTestId('document-editor')
    expect(getRawEditorText(auxEditor)).toContain('status: todo')

    // Re-open shared.md in win1 too so both main & auxiliary edit the same document buffer simultaneously
    const explorer1 = within(rendered1.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer1).findByText('shared.md'))
    const mainEditor = await within(rendered1.container).findByTestId('document-editor')

    // Expand auxiliary right sidebar -> shows 2-tier accordion (Outline 35% + 문서 속성 65% + horizontal resizer)
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))
    const auxRightSidebar = within(auxRendered.container).getByRole('complementary', {
      name: '우측 사이드바'
    })
    const auxOutline = within(auxRightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
    const auxProps = within(auxRightSidebar).getByRole('region', { name: '문서 속성' })
    const auxSectionResizer = within(auxRightSidebar).getByRole('separator', {
      name: '우측 사이드바 섹션 높이 조절'
    })
    expect(auxOutline).toHaveStyle({ flex: '0.35 1 0%' })
    expect(auxProps).toHaveStyle({ flex: '0.65 1 0%' })
    expect(auxSectionResizer).toHaveAttribute('aria-valuenow', '35')

    // Wait for schema to load in auxiliary window and verify property value
    await waitFor(() => {
      expect(within(auxProps).getByLabelText('상태')).toHaveValue('todo')
    })

    // Edit property in auxiliary window -> syncs dirty state, Main Raw YAML, and Main Properties immediately
    await user.selectOptions(within(auxProps).getByLabelText('상태'), 'in-progress')
    await user.type(within(auxProps).getByLabelText('담당자'), 'alice')

    await waitFor(() => {
      expect(within(auxRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
      expect(getRawEditorText(mainEditor)).toContain('status: in-progress')
      expect(getRawEditorText(mainEditor)).toContain('owner: alice')
    })
    const mainProps = within(rendered1.container).getByRole('region', { name: '문서 속성' })
    expect(within(mainProps).getByLabelText('상태')).toHaveValue('in-progress')
    expect(within(mainProps).getByLabelText('담당자')).toHaveValue('alice')

    // Raw edit in Main syncs back to Auxiliary Properties in real time
    setRawEditorText(mainEditor, '---\nstatus: done\nowner: bob\n---\n# Shared Title\n\nBody')
    await waitFor(() => {
      expect(within(auxProps).getByLabelText('상태')).toHaveValue('done')
      expect(within(auxProps).getByLabelText('담당자')).toHaveValue('bob')
    })

    // Save via Ctrl+S in auxiliary -> persists to disk and clears dirty in BOTH windows
    fireEvent.keyDown(auxEditor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(within(auxRendered.container).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(within(rendered1.container).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(harness.getFilesSnapshot().get('C:/wiki/docs/shared.md')).toContain('status: done')
    })
  })

  it('broadcasts schema creation across main and auxiliary windows while isolating separate workspace sessions', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': {
            'alpha.md': '---\nstatus: todo\n---\n# Alpha'
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta'
          }
        }
      }
    )

    const alphaMain = harness.createWindow({ role: 'main' })
    const alphaRendered = render(<App wikiApi={alphaMain.api} />)

    await openFolderAndNoteInWindow(user, alphaRendered.container, alphaMain.emitMenuCommand, 'alpha.md')
    const alphaExplorer = within(alphaRendered.container).getByLabelText('워크스페이스 탐색기')

    await detachTabViaContextMenu(user, alphaRendered.container, /alpha\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(alphaMain.windowId)).toHaveLength(1)
    })
    const alphaAux = harness.getAuxiliaryWindows(alphaMain.windowId)[0]
    const alphaAuxRendered = render(<App wikiApi={alphaAux.api} />)
    await user.click(within(alphaAuxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))

    // Open Beta in an isolated second main window session
    const openedBeta = await alphaMain.api.workspace.openInNewWindow!('C:\\wiki\\beta')
    expect(openedBeta.status).toBe('opened')
    const betaMain = harness.getMainWindows().find((w) => w.windowId === openedBeta.windowId)!
    const betaRendered = render(<App wikiApi={betaMain.api} />)
    const betaExplorer = await within(betaRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(betaExplorer).findByText('beta.md'))

    // Re-open alpha.md in alphaMain and create schema in alphaMain
    await user.click(await within(alphaExplorer).findByText('alpha.md'))
    const alphaProps = within(alphaRendered.container).getByRole('region', { name: '문서 속성' })
    const auxProps = within(alphaAuxRendered.container).getByRole('region', { name: '문서 속성' })
    const betaProps = within(betaRendered.container).getByRole('region', { name: '문서 속성' })

    await waitFor(() => {
      expect(within(alphaProps).getByRole('button', { name: '스키마 생성' })).toBeInTheDocument()
      expect(within(auxProps).getByRole('button', { name: '스키마 생성' })).toBeInTheDocument()
      expect(within(betaProps).getByRole('button', { name: '스키마 생성' })).toBeInTheDocument()
    })

    await user.click(within(alphaProps).getByRole('button', { name: '스키마 생성' }))

    // Alpha main & Alpha auxiliary immediately receive starter schema; Beta stays without schema
    await waitFor(() => {
      expect(within(alphaProps).getByLabelText('상태')).toHaveValue('todo')
      expect(within(auxProps).getByLabelText('상태')).toHaveValue('todo')
    })
    expect(within(betaProps).getByRole('button', { name: '스키마 생성' })).toBeInTheDocument()
  })

  it('propagates modal schema saves, Raw JSON tab edits, and invalid schema error/recovery between main and auxiliary windows while keeping other sessions isolated', async () => {
    const user = userEvent.setup()
    const alphaContent = '---\nstatus: todo\n---\n# Alpha\n\nBody'
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(TEAM_SCHEMA),
            'alpha.md': alphaContent
          },
          'C:\\wiki\\beta': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(TEAM_SCHEMA),
            'beta.md': '---\nstatus: todo\n---\n# Beta'
          }
        }
      }
    )

    const alphaMain = harness.createWindow({ role: 'main' })
    const alphaRendered = render(<App wikiApi={alphaMain.api} />)
    await openFolderAndNoteInWindow(user, alphaRendered.container, alphaMain.emitMenuCommand, 'alpha.md')

    await detachTabViaContextMenu(user, alphaRendered.container, /alpha\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(alphaMain.windowId)).toHaveLength(1)
    })
    const alphaAux = harness.getAuxiliaryWindows(alphaMain.windowId)[0]
    const alphaAuxRendered = render(<App wikiApi={alphaAux.api} />)
    await user.click(within(alphaAuxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))

    // Re-open alpha.md in alphaMain as well
    const alphaExplorer = within(alphaRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(alphaExplorer).findByText('alpha.md'))

    // Open isolated Beta main window
    const openedBeta = await alphaMain.api.workspace.openInNewWindow!('C:\\wiki\\beta')
    const betaMain = harness.getMainWindows().find((w) => w.windowId === openedBeta.windowId)!
    const betaRendered = render(<App wikiApi={betaMain.api} />)
    const betaExplorer = await within(betaRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(betaExplorer).findByText('beta.md'))

    const alphaProps = within(alphaRendered.container).getByRole('region', { name: '문서 속성' })
    const auxProps = within(alphaAuxRendered.container).getByRole('region', { name: '문서 속성' })
    const betaProps = within(betaRendered.container).getByRole('region', { name: '문서 속성' })

    await waitFor(() => {
      expect(within(alphaProps).getByLabelText('상태')).toHaveValue('todo')
      expect(within(auxProps).getByLabelText('상태')).toHaveValue('todo')
      expect(within(betaProps).getByLabelText('상태')).toHaveValue('todo')
    })

    // 1. Edit & save schema in Alpha Main modal -> immediately updates BOTH Alpha Main & Alpha Auxiliary (Beta stays isolated)
    await user.click(within(alphaProps).getByRole('button', { name: '스키마 관리' }))
    const mainModal = within(alphaRendered.container).getByRole('dialog', {
      name: '프론트매터 스키마 관리'
    })
    await user.click(within(mainModal).getByRole('button', { name: '+ 필드 추가' }))
    const newField = within(mainModal).getByRole('group', { name: '새 필드 3' })
    await user.type(within(newField).getByLabelText('키'), 'reviewer')
    await user.type(within(newField).getByLabelText('라벨'), '리뷰어')
    await user.click(
      within(within(mainModal).getByRole('group', { name: '필드 리뷰어' })).getByRole('checkbox', {
        name: '필수 항목'
      })
    )
    await user.click(within(mainModal).getByRole('button', { name: '저장' }))

    await waitFor(() => {
      expect(within(alphaProps).getByLabelText('리뷰어')).toBeInTheDocument()
      expect(within(auxProps).getByLabelText('리뷰어')).toBeInTheDocument()
      expect(within(alphaProps).getByLabelText('유효성 경고 1건')).toHaveTextContent('⚠ 1')
      expect(within(auxProps).getByLabelText('유효성 경고 1건')).toHaveTextContent('⚠ 1')
    })
    expect(within(betaProps).queryByLabelText('리뷰어')).not.toBeInTheDocument()

    // 2. In Auxiliary Window, open frontmatter.json in Raw JSON tab & save invalid JSON -> both Main & Aux show error while preserving alpha.md
    await user.click(within(auxProps).getByRole('button', { name: '스키마 관리' }))
    const auxModal = within(alphaAuxRendered.container).getByRole('dialog', {
      name: '프론트매터 스키마 관리'
    })
    await user.click(within(auxModal).getByRole('button', { name: 'JSON 파일로 열기' }))
    await waitFor(() => {
      expect(
        within(alphaAuxRendered.container).getByRole('tab', { name: /frontmatter\.json/ })
      ).toBeInTheDocument()
    })

    const auxRawEditor = within(alphaAuxRendered.container).getByTestId('document-editor')
    setRawEditorText(auxRawEditor, '{ invalid json')
    fireEvent.keyDown(auxRawEditor, { key: 's', ctrlKey: true })

    await user.click(within(alphaAuxRendered.container).getByRole('tab', { name: /alpha\.md/ }))
    await waitFor(() => {
      expect(within(alphaProps).getByText('스키마 오류')).toBeInTheDocument()
      expect(within(auxProps).getByText('스키마 오류')).toBeInTheDocument()
    })
    expect(within(betaProps).queryByText('스키마 오류')).not.toBeInTheDocument()
    expect(getRawEditorText(within(alphaRendered.container).getByTestId('document-editor'))).toBe(
      alphaContent
    )

    // 3. Recover via Main Window schema modal -> restores both Alpha Main & Alpha Auxiliary
    await user.click(within(alphaProps).getAllByRole('button', { name: '스키마 관리' })[1])
    const recoveryModal = within(alphaRendered.container).getByRole('dialog', {
      name: '프론트매터 스키마 관리'
    })
    await user.click(within(recoveryModal).getByRole('button', { name: '기본 템플릿 불러오기' }))
    await user.click(within(recoveryModal).getByRole('button', { name: '저장' }))

    await waitFor(() => {
      expect(within(alphaProps).queryByText('스키마 오류')).not.toBeInTheDocument()
      expect(within(auxProps).queryByText('스키마 오류')).not.toBeInTheDocument()
      expect(within(alphaProps).getByLabelText('상태')).toHaveValue('todo')
      expect(within(auxProps).getByLabelText('상태')).toHaveValue('todo')
    })
  })

  it('suggests disk and unsaved auxiliary buffer custom values in allowCustom multi-select DocumentPropertiesSection while isolating other sessions', async () => {
    const user = userEvent.setup()
    const customSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        {
          key: 'labels',
          label: '라벨',
          type: 'multi-select',
          allowCustom: true,
          options: [{ value: 'docs' }, { value: 'backend' }]
        }
      ]
    }
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(customSchema),
            'disk-only.md': '---\nlabels: [disk-tag]\n---\n# Disk',
            'aux-doc.md': '---\nlabels: [docs]\n---\n# Aux',
            'main-doc.md': '---\nlabels: [docs]\n---\n# Main'
          },
          'C:\\wiki\\beta': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(customSchema),
            'beta.md': '---\nlabels: [beta-secret-tag]\n---\n# Beta'
          }
        }
      }
    )

    const alphaMain = harness.createWindow({ role: 'main' })
    const alphaRendered = render(<App wikiApi={alphaMain.api} />)
    await openFolderAndNoteInWindow(user, alphaRendered.container, alphaMain.emitMenuCommand, 'aux-doc.md')

    await detachTabViaContextMenu(user, alphaRendered.container, /aux-doc\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(alphaMain.windowId)).toHaveLength(1)
    })
    const alphaAux = harness.getAuxiliaryWindows(alphaMain.windowId)[0]
    const auxRendered = render(<App wikiApi={alphaAux.api} />)
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))
    const auxProps = within(auxRendered.container).getByRole('region', { name: '문서 속성' })
    await waitFor(() => {
      expect(within(auxProps).getByLabelText('라벨')).toBeInTheDocument()
    })

    // Open isolated Beta main window
    const openedBeta = await alphaMain.api.workspace.openInNewWindow!('C:\\wiki\\beta')
    const betaMain = harness.getMainWindows().find((w) => w.windowId === openedBeta.windowId)!
    const betaRendered = render(<App wikiApi={betaMain.api} />)
    const betaExplorer = await within(betaRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(betaExplorer).findByText('beta.md'))

    // Unsaved custom tag typed in auxiliary window's aux-doc.md
    await user.type(within(auxProps).getByLabelText('라벨'), 'aux-unsaved-tag{Enter}')

    // Open main-doc.md in alphaMain -> Properties suggests schema option 'backend', disk 'disk-tag', AND unsaved 'aux-unsaved-tag' (never beta's tag)
    const alphaExplorer = within(alphaRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(alphaExplorer).findByText('main-doc.md'))
    const mainProps = within(alphaRendered.container).getByRole('region', { name: '문서 속성' })

    await waitFor(() => {
      const suggestions = within(mainProps).getByLabelText('라벨 제안')
      expect(within(suggestions).getByRole('button', { name: '+ backend' })).toBeInTheDocument()
      expect(within(suggestions).getByRole('button', { name: '+ disk-tag' })).toBeInTheDocument()
      expect(within(suggestions).getByRole('button', { name: '+ aux-unsaved-tag' })).toBeInTheDocument()
      expect(within(suggestions).queryByRole('button', { name: '+ beta-secret-tag' })).not.toBeInTheDocument()
    })

    // Clicking '+ aux-unsaved-tag' adds it to main-doc.md
    await user.click(within(mainProps).getByRole('button', { name: '+ aux-unsaved-tag' }))
    expect(getRawEditorText(within(alphaRendered.container).getByTestId('document-editor'))).toContain(
      'aux-unsaved-tag'
    )

    // Alpha Main Search View filter picker also proposes 'aux-unsaved-tag' (not beta-secret-tag) and filters aux-doc.md via unsaved buffer
    await user.click(
      within(within(alphaRendered.container).getByRole('navigation', { name: '액티비티 바' })).getByRole(
        'button',
        { name: '검색' }
      )
    )
    const alphaSearchView = within(alphaRendered.container).getByRole('region', { name: '검색 뷰' })
    const alphaFilterBar = within(alphaSearchView).getByRole('region', {
      name: '프론트매터 필터 바'
    })
    await user.click(within(alphaFilterBar).getByRole('button', { name: '+ 필터 추가' }))
    const searchPopover = within(alphaFilterBar).getByRole('dialog', {
      name: '프론트매터 필터 설정'
    })
    await user.click(within(searchPopover).getByRole('option', { name: /라벨/ }))
    await user.click(within(searchPopover).getByRole('option', { name: '모두 포함' }))
    await waitFor(() => {
      expect(within(searchPopover).getByLabelText('aux-unsaved-tag')).toBeInTheDocument()
      expect(within(searchPopover).queryByLabelText('beta-secret-tag')).not.toBeInTheDocument()
    })
    await user.click(within(searchPopover).getByLabelText('aux-unsaved-tag'))
    await user.click(within(searchPopover).getByRole('button', { name: '적용' }))

    await waitFor(() => {
      const list = within(alphaSearchView).getByRole('list', { name: '검색 결과 목록' })
      expect(within(list).getByText('aux-doc.md')).toBeInTheDocument()
      expect(within(list).getByText('main-doc.md')).toBeInTheDocument()
      expect(within(list).queryByText('disk-only.md')).not.toBeInTheDocument()
    })
  })
})
