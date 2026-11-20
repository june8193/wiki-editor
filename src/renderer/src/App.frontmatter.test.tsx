import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus } from '@shared/git'
import {
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  parseFrontmatterDocument,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { App } from './App'
import { switchPaneEditorMode } from './test/appTestHelpers'
import {
  createInMemoryWikiApi,
  getRawEditorSelection,
  getRawEditorText,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

const ALL_TYPES_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'status',
      label: '상태',
      type: 'select',
      required: true,
      options: [
        { value: 'todo', color: '#64748b' },
        { value: 'in-progress', color: '#2563eb' },
        { value: 'done', color: '#16a34a' }
      ]
    },
    { key: 'priority', label: '우선순위', type: 'number' },
    { key: 'published', label: '공개 여부', type: 'boolean' },
    { key: 'dueDate', label: '마감일', type: 'date' },
    { key: 'assignee', label: '담당자', type: 'text', placeholder: '담당자 입력' },
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      options: [
        { value: 'docs', color: '#0284c7' },
        { value: 'backend', color: '#7c3aed' }
      ]
    },
    {
      key: 'platforms',
      label: '플랫폼',
      type: 'multi-select',
      allowCustom: false,
      options: [{ value: 'web' }, { value: 'desktop' }]
    }
  ]
}

describe('App frontmatter properties & right sidebar 2-tier accordion integration', () => {
  const disposers: Array<() => void> = []

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose()
    }
  })

  it('provides 2-tier right sidebar accordion, horizontal section resizer, preserved sidebar resizer, and 스키마 생성 initialization', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\fm',
        workspaces: {
          'C:\\wiki\\fm': {
            'guide.md': '# Overview\n\n## Details'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))

    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
    const properties = within(rightSidebar).getByRole('region', { name: '문서 속성' })
    const sectionResizer = within(rightSidebar).getByRole('separator', {
      name: '우측 사이드바 섹션 높이 조절'
    })

    expect(outline).toHaveStyle({ flex: '0.35 1 0%' })
    expect(properties).toHaveStyle({ flex: '0.65 1 0%' })
    expect(sectionResizer).toHaveAttribute('aria-valuenow', '35')

    // Horizontal section resizer supports keyboard & double-click 50% restore
    fireEvent.keyDown(sectionResizer, { key: 'ArrowDown' })
    expect(sectionResizer).toHaveAttribute('aria-valuenow', '40')
    fireEvent.doubleClick(sectionResizer)
    expect(sectionResizer).toHaveAttribute('aria-valuenow', '50')

    // Preserves left-edge SidebarResizer (180px~500px) and right collapse/expand tab
    const sidebarResizer = screen.getByRole('separator', { name: '우측 사이드바 너비 조절' })
    fireEvent.keyDown(sidebarResizer, { key: 'ArrowLeft' })
    expect(Number(sidebarResizer.getAttribute('aria-valuenow'))).toBeGreaterThan(240)

    await user.click(within(outline).getByRole('button', { name: '문서 목차 접기' }))
    expect(screen.queryByRole('complementary', { name: '우측 사이드바' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '문서 목차 펼치기' }))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBeInTheDocument()

    // Missing schema -> click '스키마 생성' initializes .wiki-editor/frontmatter.json
    const reopenedProps = screen.getByRole('region', { name: '문서 속성' })
    await user.click(within(reopenedProps).getByRole('button', { name: '스키마 생성' }))

    await waitFor(() => {
      expect(getFilesSnapshot().has(`C:/wiki/fm/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`)).toBe(true)
      expect(within(reopenedProps).getByRole('button', { name: '+ 속성 추가' })).toBeInTheDocument()
    })
    expect(within(reopenedProps).getByText('0/5')).toBeInTheDocument()
  })

  it('creates/edits/removes frontmatter via 6 widgets, preserves unknown fields & comments, updates dirty state, and auto-saves', async () => {
    const user = userEvent.setup()
    const initialDoc = [
      '---',
      '# preserve header comment',
      'status: todo',
      'legacyOwner: infra-team',
      '---',
      '# Spec Doc',
      '',
      'Body content'
    ].join('\r\n')

    const { api, emitMenuCommand, getFilesSnapshot, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false, autoSaveDelayMs: 60 },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(ALL_TYPES_SCHEMA),
            'spec.md': initialDoc,
            'empty.md': '# Plain Note'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('spec.md'))

    const properties = screen.getByRole('region', { name: '문서 속성' })
    await waitFor(() => {
      expect(within(properties).getByLabelText('상태')).toBeInTheDocument()
    })
    expect(within(properties).getByText('1/7')).toBeInTheDocument()

    // Edit all 6 field types in Properties section (keep autoSave disabled until dirty-indicator is verified)
    await user.selectOptions(within(properties).getByLabelText('상태'), 'in-progress')
    await user.type(within(properties).getByLabelText('우선순위'), '2')
    await user.click(within(properties).getByRole('checkbox', { name: '공개 여부' }))
    fireEvent.change(within(properties).getByLabelText('마감일'), {
      target: { value: '2026-12-15' }
    })
    await user.type(within(properties).getByLabelText('담당자'), 'bob')
    await user.type(within(properties).getByLabelText('라벨'), 'custom-tag{Enter}')

    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Unknown field collapsible displays legacyOwner and preserves it through auto-save
    await user.click(within(properties).getByRole('button', { name: '미정의 필드 (1) · 보존' }))
    expect(within(properties).getByText('legacyOwner')).toBeInTheDocument()
    expect(within(properties).getByText('infra-team')).toBeInTheDocument()

    // Enable auto-save, then apply final schema option chip so auto-save schedules deterministically
    await api.config.update({ autoSave: true, autoSaveDelayMs: 60 })
    await user.click(within(properties).getByRole('button', { name: '+ desktop' }))
    expect(within(properties).getByText('7/7')).toBeInTheDocument()

    await waitFor(
      () => {
        expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
        const saved = getFilesSnapshot().get('C:/wiki/docs/spec.md') ?? ''
        expect(saved).toContain('# preserve header comment\r\n')
        expect(saved).toContain('legacyOwner: infra-team\r\n')
        expect(saved).toContain('status: in-progress\r\n')
        expect(saved).toContain('priority: 2\r\n')
        expect(saved).toContain('published: true\r\n')
        expect(saved).toContain('dueDate: 2026-12-15\r\n')
        expect(saved).toContain('assignee: bob\r\n')
        expect(saved).toContain('custom-tag')
        expect(saved).toContain('desktop')
      },
      { timeout: 2000 }
    )

    // '+ 속성 추가' & '프론트매터 제거' on empty.md
    await user.click(within(explorer).getByText('empty.md'))
    await user.click(within(properties).getByRole('button', { name: '+ 속성 추가' }))
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('---\n---\n# Plain Note')

    await user.click(within(properties).getByRole('button', { name: '프론트매터 제거' }))
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Plain Note')
  })

  it('synchronizes bidirectionally in real time across Raw (keeping focus/cursor), Split, 위지윅 (keeping caret), and Preview', async () => {
    const user = userEvent.setup()
    const docText = [
      '---',
      'status: todo',
      '---',
      '# Title',
      '',
      'AlphaBeta'
    ].join('\n')

    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\sync',
        workspaces: {
          'C:\\wiki\\sync': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(ALL_TYPES_SCHEMA),
            'note.md': docText
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('note.md'))

    const properties = screen.getByRole('region', { name: '문서 속성' })
    await waitFor(() => {
      expect(within(properties).getByLabelText('상태')).toHaveValue('todo')
    })

    // 1. Raw mode: editing YAML keeps Raw focus/cursor intact while updating Properties immediately
    const rawEditor = screen.getByTestId('document-editor')
    rawEditor.focus()
    const statusPos = docText.indexOf('todo')
    setRawEditorSelection(rawEditor, statusPos, statusPos + 4)
    setRawEditorText(
      rawEditor,
      docText.replace('status: todo', 'status: done\nassignee: kim')
    )
    setRawEditorSelection(rawEditor, 28, 28)

    expect(document.activeElement === rawEditor || rawEditor.contains(document.activeElement)).toBe(true)
    expect(getRawEditorSelection(rawEditor)).toEqual({ start: 28, end: 28 })
    expect(within(properties).getByLabelText('상태')).toHaveValue('done')
    expect(within(properties).getByLabelText('담당자')).toHaveValue('kim')

    // 2. Split mode: GUI edit updates left Raw & keeps right Preview clean of frontmatter
    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, 'Split')
    await user.selectOptions(within(properties).getByLabelText('상태'), 'in-progress')

    const splitRaw = within(primaryPane).getByTestId('document-editor')
    const splitPreview = within(primaryPane).getByTestId('split-markdown-preview')
    expect(getRawEditorText(splitRaw)).toContain('status: in-progress')
    expect(splitPreview.textContent).not.toContain('in-progress')
    expect(within(splitPreview).getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()

    // 3. 위지윅 mode: GUI property edit preserves TipTap body caret & allows subsequent typing
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    const wysiwygSurface = within(primaryPane).getByLabelText('위지윅 문서 에디터')
    const pText = Array.from(wysiwygSurface.querySelectorAll('p')).find(
      (p) => p.textContent === 'AlphaBeta'
    )?.firstChild
    expect(pText).toBeTruthy()
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(pText!, 5)
    range.collapse(true)
    wysiwygSurface.focus()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.change(within(properties).getByLabelText('상태'), { target: { value: 'done' } })
    expect(selection.anchorNode).toBe(pText)
    expect(selection.anchorOffset).toBe(5)
    await user.keyboard('!')

    await waitFor(() => {
      expect(wysiwygSurface.textContent).toContain('Alpha!Beta')
    })

    await switchPaneEditorMode(user, primaryPane, 'Raw')
    const parsed = parseFrontmatterDocument(
      getRawEditorText(within(primaryPane).getByTestId('document-editor')),
      ALL_TYPES_SCHEMA
    )
    expect(parsed.values.status).toBe('done')
    expect(parsed.body).toContain('Alpha!Beta')
  })

  it('displays non-blocking soft warnings without blocking Ctrl+S save, protects syntax errors, and shows markdown-only notice for non-markdown/Diff/image tabs', async () => {
    const user = userEvent.setup()
    const invalidDoc = [
      '---',
      'status: unknown-state',
      'dueDate: 2026-02-30',
      '---',
      '# Warning Doc'
    ].join('\n')

    const { api, emitMenuCommand, getFilesSnapshot, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\warn',
        workspaces: {
          'C:\\wiki\\warn': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(ALL_TYPES_SCHEMA),
            'warn.md': invalidDoc,
            'broken.md': '---\nbad: [unclosed\n---\n# Safe',
            'notes.txt': 'plain text',
            'photo.png': '<binary>'
          }
        },
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            unstaged: [{ path: 'warn.md', status: 'M' }]
          }),
          diff: async (_workspacePath, req) => ({
            path: req.path,
            status: req.status,
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: true,
            rawPatch: '@@ -1 +1 @@\n-old\n+new'
          })
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('warn.md'))

    const properties = screen.getByRole('region', { name: '문서 속성' })
    await waitFor(() => {
      expect(within(properties).getByLabelText('유효성 경고 2건')).toHaveTextContent('⚠ 2')
    })

    // Soft warnings do NOT block editing another field or saving with Ctrl+S
    await user.type(within(properties).getByLabelText('담당자'), 'lee')
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(getFilesSnapshot().get('C:/wiki/warn/warn.md')).toContain('assignee: lee')
    })

    // YAML syntax error protects raw block
    await user.click(within(explorer).getByText('broken.md'))
    expect(within(properties).getByText('YAML 구문 오류 · 미파싱 원문 보호')).toBeInTheDocument()
    expect(within(properties).queryByRole('button', { name: '프론트매터 제거' })).not.toBeInTheDocument()

    // Non-markdown .txt -> markdown-only notice
    await user.click(within(explorer).getByText('notes.txt'))
    expect(within(properties).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()

    // Image preview tab -> markdown-only notice
    await user.click(within(explorer).getByText('photo.png'))
    expect(within(properties).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()

    // config.json -> markdown-only notice
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(await screen.findByRole('button', { name: '설정 파일 직접 열기' }))
    expect(within(properties).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()

    // Diff tab -> markdown-only notice
    await user.click(within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', { name: 'Git' }))
    const gitPanel = await screen.findByRole('region', { name: 'Git 소스 제어' })
    await user.click(await within(gitPanel).findByText('warn.md'))
    expect(within(properties).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()
  })

  it('opens and closes 스키마 관리 모달 from ⚙ header button and missing-schema notice, and suppresses editor and global shortcuts while open', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\modal-shell',
        workspaces: {
          'C:\\wiki\\modal-shell': {
            'guide.md': '# Guide\n\nBody'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))

    const editor = await screen.findByTestId('document-editor')
    setRawEditorText(editor, '# Guide\n\nBody edited')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // 1. Open from missing-schema notice card and close with 닫기 button
    const properties = screen.getByRole('region', { name: '문서 속성' })
    const noticeManageBtn = within(properties).getAllByRole('button', { name: '스키마 관리' })[1]
    await user.click(noticeManageBtn)

    const modal1 = screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })
    expect(modal1).toHaveAttribute('aria-modal', 'true')
    await user.click(within(modal1).getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('dialog', { name: '프론트매터 스키마 관리' })).not.toBeInTheDocument()

    // 2. Open from ⚙ header button without collapsing the accordion
    const headerManageBtn = within(properties).getAllByRole('button', { name: '스키마 관리' })[0]
    await user.click(headerManageBtn)
    const modal2 = screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })
    expect(within(properties).getByRole('button', { name: '스키마 생성' })).toBeInTheDocument()

    // 3. Editor & global shortcuts are suppressed while modal is open
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor, { key: '2', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true })

    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/modal-shell/guide.md')).toBe('# Guide\n\nBody')
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '검색 뷰' })).not.toBeInTheDocument()

    // 4. Close with Esc key, then Ctrl+S works again
    fireEvent.keyDown(modal2, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '프론트매터 스키마 관리' })).not.toBeInTheDocument()

    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(getFilesSnapshot().get('C:/wiki/modal-shell/guide.md')).toBe('# Guide\n\nBody edited')
    })
  })

  it('saves modal schema edits atomically, updates properties & warnings immediately without mutating markdown, and syncs open clean frontmatter.json tab', async () => {
    const user = userEvent.setup()
    const initialSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        {
          key: 'status',
          label: '상태',
          type: 'select',
          options: [{ value: 'todo' }, { value: 'done' }]
        }
      ]
    }
    const noteContent = '---\nstatus: todo\n---\n# Note\n\nBody'

    const { api, emitMenuCommand, getFilesSnapshot, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\schema-save',
        workspaces: {
          'C:\\wiki\\schema-save': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(initialSchema),
            'note.md': noteContent
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('note.md'))
    const properties = screen.getByRole('region', { name: '문서 속성' })
    await waitFor(() => {
      expect(within(properties).getByLabelText('상태')).toHaveValue('todo')
    })

    // Also open frontmatter.json tab via modal 'JSON 파일로 열기' so we verify clean tab stays synced on later modal save
    await user.click(within(properties).getByRole('button', { name: '스키마 관리' }))
    await user.click(
      within(screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })).getByRole('button', {
        name: 'JSON 파일로 열기'
      })
    )
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /frontmatter\.json/ })).toBeInTheDocument()
    })

    // Switch back to note.md tab, open modal via ⚙, remove 'todo' option from status, add required 'reviewer' field
    await user.click(screen.getByRole('tab', { name: /note\.md/ }))
    await user.click(within(properties).getByRole('button', { name: '스키마 관리' }))
    const modal = screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })

    const statusGroup = within(modal).getByRole('group', { name: '필드 상태' })
    const todoOptionRow = within(statusGroup).getByRole('group', { name: '옵션 1' })
    await user.click(within(todoOptionRow).getByRole('button', { name: '옵션 삭제' }))

    await user.click(within(modal).getByRole('button', { name: '+ 필드 추가' }))
    const newField = within(modal).getByRole('group', { name: '새 필드 2' })
    await user.type(within(newField).getByLabelText('키'), 'reviewer')
    await user.type(within(newField).getByLabelText('라벨'), '리뷰어')
    const reviewerField = within(modal).getByRole('group', { name: '필드 리뷰어' })
    await user.click(within(reviewerField).getByRole('checkbox', { name: '필수 항목' }))

    await user.click(within(modal).getByRole('button', { name: '저장' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '프론트매터 스키마 관리' })).not.toBeInTheDocument()
      expect(within(properties).getByLabelText('리뷰어')).toBeInTheDocument()
      expect(within(properties).getByLabelText('유효성 경고 2건')).toHaveTextContent('⚠ 2')
    })

    // Markdown document content remains untouched & clean
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(noteContent)

    // Disk frontmatter.json & open clean frontmatter.json tab both reflect the updated schema
    expect(getFilesSnapshot().get(`C:/wiki/schema-save/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`)).toContain(
      '"reviewer"'
    )
    await user.click(screen.getByRole('tab', { name: /frontmatter\.json/ }))
    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('"reviewer"')
    })
  })

  it('opens frontmatter.json in Raw JSON tab when missing, reloads on Ctrl+S & external changes, and handles invalid JSON/schema recovery safely while preserving markdown frontmatter', async () => {
    const user = userEvent.setup()
    const docContent = [
      '---',
      '# keep this yaml comment',
      'status: todo',
      '---',
      '# Guide',
      '',
      'Body'
    ].join('\n')

    const { api, emitMenuCommand, emitWorkspaceChange, getFilesSnapshot, dispose } =
      createInMemoryWikiApi(
        { theme: 'light', autoSave: false },
        {
          selectedFolder: 'C:\\wiki\\raw-sync',
          workspaces: {
            'C:\\wiki\\raw-sync': {
              'guide.md': docContent
            }
          }
        }
      )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))

    const properties = screen.getByRole('region', { name: '문서 속성' })
    const headerManageBtn = within(properties).getAllByRole('button', { name: '스키마 관리' })[0]
    await user.click(headerManageBtn)

    // 1. When schema file is missing, 'JSON 파일로 열기' creates starter file & opens Raw JSON tab
    const modal = screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })
    await user.click(within(modal).getByRole('button', { name: 'JSON 파일로 열기' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '프론트매터 스키마 관리' })).not.toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /frontmatter\.json/ })).toBeInTheDocument()
    })
    const schemaPath = `C:/wiki/raw-sync/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`
    expect(getFilesSnapshot().has(schemaPath)).toBe(true)

    const schemaRawEditor = screen.getByTestId('document-editor')
    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    expect(within(modeGroup).getByRole('button', { name: '위지윅' })).toBeDisabled()
    expect(within(modeGroup).getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(within(modeGroup).getByRole('button', { name: 'Split' })).toBeDisabled()

    // 2. Edit Raw JSON to add required 'owner' field & save via Ctrl+S -> updates guide.md properties
    const updatedSchemaJson = JSON.stringify(
      {
        version: 1,
        fields: [
          { key: 'status', label: '상태', type: 'select', options: [{ value: 'todo' }] },
          { key: 'owner', label: '소유자', type: 'text', required: true }
        ]
      },
      null,
      2
    )
    setRawEditorText(schemaRawEditor, updatedSchemaJson)
    fireEvent.keyDown(schemaRawEditor, { key: 's', ctrlKey: true })

    await user.click(screen.getByRole('tab', { name: /guide\.md/ }))
    await waitFor(() => {
      expect(within(properties).getByLabelText('소유자')).toBeInTheDocument()
      expect(within(properties).getByLabelText('유효성 경고 1건')).toHaveTextContent('⚠ 1')
    })

    // 3. Save invalid JSON in Raw JSON tab -> clear error + recovery buttons, markdown frontmatter preserved
    await user.click(screen.getByRole('tab', { name: /frontmatter\.json/ }))
    const brokenEditor = screen.getByTestId('document-editor')
    setRawEditorText(brokenEditor, '{ invalid json')
    fireEvent.keyDown(brokenEditor, { key: 's', ctrlKey: true })

    await user.click(screen.getByRole('tab', { name: /guide\.md/ }))
    await waitFor(() => {
      expect(within(properties).getByText('스키마 오류')).toBeInTheDocument()
      expect(within(properties).getByText(/frontmatter\.json 구문 오류/)).toBeInTheDocument()
      expect(within(properties).getByRole('button', { name: 'JSON 파일로 열기' })).toBeInTheDocument()
    })
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)

    // 4. External schema repair via filesystem change auto-reloads and clears error
    await api.workspace.writeFile(
      schemaPath,
      JSON.stringify({
        version: 1,
        fields: [{ key: 'status', label: '상태', type: 'select', options: [{ value: 'todo' }] }]
      })
    )
    act(() => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki/raw-sync',
        eventType: 'change',
        relativePath: FRONTMATTER_SCHEMA_RELATIVE_PATH
      })
    })

    await waitFor(() => {
      expect(within(properties).queryByText('스키마 오류')).not.toBeInTheDocument()
      expect(within(properties).getByLabelText('상태')).toHaveValue('todo')
    })

    // 5. External invalid schema -> recover by clicking 'JSON 파일로 열기' from error notice
    await api.workspace.writeFile(schemaPath, JSON.stringify({ version: 2, fields: [] }))
    await waitFor(() => {
      expect(within(properties).getByText('스키마 오류')).toBeInTheDocument()
      expect(within(properties).getByText(/지원하지 않는 스키마 version/)).toBeInTheDocument()
    })

    await user.click(within(properties).getByRole('button', { name: 'JSON 파일로 열기' }))
    await waitFor(() => {
      const activeEditor = screen.getByTestId('document-editor')
      expect(getRawEditorText(activeEditor)).toContain('"version":2')
    })
    const recoveryEditor = screen.getByTestId('document-editor')
    setRawEditorText(recoveryEditor, updatedSchemaJson)
    fireEvent.keyDown(recoveryEditor, { key: 's', ctrlKey: true })

    await user.click(screen.getByRole('tab', { name: /guide\.md/ }))
    await waitFor(() => {
      expect(within(properties).queryByText('스키마 오류')).not.toBeInTheDocument()
      expect(within(properties).getByLabelText('소유자')).toBeInTheDocument()
    })
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
  })

  it('keeps 스키마 관리 모달 open with inline error and preserves unsaved draft when JSON 파일로 열기 fails', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\raw-open-error',
        workspaces: {
          'C:\\wiki\\raw-open-error': {
            'guide.md': '# Guide\n\nBody'
          }
        }
      }
    )
    disposers.push(dispose)

    const origCreateDefault = api.frontmatter!.createDefaultSchema
    const origOpenWorkspaceFile = api.buffer.openWorkspaceFile
    let failCreateDefault = true
    let failOpenRaw = true
    api.frontmatter!.createDefaultSchema = async () => {
      if (failCreateDefault) {
        throw new Error('스키마 기본 템플릿 쓰기 권한이 없습니다.')
      }
      return origCreateDefault()
    }
    api.buffer.openWorkspaceFile = async (filePath, name, initialContent) => {
      if (failOpenRaw && filePath.endsWith('frontmatter.json')) {
        throw new Error('JSON 파일 열기에 실패했습니다.')
      }
      return origOpenWorkspaceFile(filePath, name, initialContent)
    }
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))
    const properties = screen.getByRole('region', { name: '문서 속성' })
    const manageBtns = await within(properties).findAllByRole('button', { name: '스키마 관리' })
    await user.click(manageBtns[0])

    const modal = screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })
    await user.click(within(modal).getByRole('button', { name: '+ 필드 추가' }))
    const draftCard = within(modal).getByRole('group', { name: '새 필드 1' })
    await user.type(within(draftCard).getByLabelText('키'), 'draft_key')

    // Case 1: createDefaultSchema fails -> inline modal alert, modal & unsaved draft remain open
    await user.click(within(modal).getByRole('button', { name: 'JSON 파일로 열기' }))
    await waitFor(() => {
      expect(within(modal).getByRole('alert')).toHaveTextContent(
        /스키마 기본 템플릿 쓰기 권한이 없습니다/
      )
    })
    expect(within(modal).getByDisplayValue('draft_key')).toBeInTheDocument()

    // Case 2: createDefaultSchema succeeds, openWorkspaceFile fails -> modal & unsaved draft still remain open with inline alert
    failCreateDefault = false
    await user.click(within(modal).getByRole('button', { name: 'JSON 파일로 열기' }))
    await waitFor(() => {
      expect(within(modal).getByRole('alert')).toHaveTextContent(/스키마 JSON 파일을 열지 못했습니다/)
    })
    expect(screen.getByRole('dialog', { name: '프론트매터 스키마 관리' })).toBeInTheDocument()
    expect(within(modal).getByDisplayValue('draft_key')).toBeInTheDocument()
  })
})
