import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultFrontmatterSchema,
  type FrontmatterSchemaLoadResult,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { DocumentPropertiesSection } from './DocumentPropertiesSection'

const FULL_SCHEMA: WorkspaceFrontmatterSchema = {
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
    {
      key: 'priority',
      label: '우선순위',
      type: 'number',
      placeholder: '1~5'
    },
    {
      key: 'published',
      label: '공개 여부',
      type: 'boolean'
    },
    {
      key: 'dueDate',
      label: '마감일',
      type: 'date'
    },
    {
      key: 'assignee',
      label: '담당자',
      type: 'text',
      placeholder: '이름 입력'
    },
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

function makeSchemaResult(
  schema: WorkspaceFrontmatterSchema | null = FULL_SCHEMA,
  overrides: Partial<FrontmatterSchemaLoadResult> = {}
): FrontmatterSchemaLoadResult {
  return {
    exists: schema !== null,
    path: 'C:/wiki/.wiki-editor/frontmatter.json',
    schema,
    ...overrides
  }
}

describe('DocumentPropertiesSection', () => {
  it('shows empty and markdown-only notices for no-doc, non-markdown, diff tab, and image preview', () => {
    const { rerender } = render(
      <DocumentPropertiesSection
        document={{
          documentName: null,
          content: '',
          isMarkdownDocument: false
        }}
        schemaResult={makeSchemaResult()}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
      />
    )

    const section = screen.getByRole('region', { name: '문서 속성' })
    expect(within(section).getByText('열린 문서가 없습니다.')).toBeInTheDocument()
    expect(within(section).queryByText(/\d+\/\d+/)).not.toBeInTheDocument()

    // Non-markdown .txt
    rerender(
      <DocumentPropertiesSection
        document={{
          documentName: 'notes.txt',
          content: 'plain',
          isMarkdownDocument: false
        }}
        schemaResult={makeSchemaResult()}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
      />
    )
    expect(within(section).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()

    // Diff tab
    rerender(
      <DocumentPropertiesSection
        document={{
          documentName: 'guide.md',
          content: '',
          isMarkdownDocument: false
        }}
        schemaResult={makeSchemaResult()}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
      />
    )
    expect(within(section).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()

    // Image preview tab
    rerender(
      <DocumentPropertiesSection
        document={{
          documentName: 'diagram.png',
          content: '',
          isMarkdownDocument: false
        }}
        schemaResult={makeSchemaResult()}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
      />
    )
    expect(within(section).getByText('마크다운 문서에서만 문서 속성을 지원합니다.')).toBeInTheDocument()
  })

  it('offers 스키마 생성 when missing and shows schema error safely when invalid', async () => {
    const user = userEvent.setup()
    const onCreateDefaultSchema = vi.fn()

    const { rerender } = render(
      <DocumentPropertiesSection
        document={{
          documentName: 'guide.md',
          content: '# Guide',
          isMarkdownDocument: true
        }}
        schemaResult={{
          exists: false,
          path: 'C:/wiki/.wiki-editor/frontmatter.json',
          schema: null
        }}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={onCreateDefaultSchema}
      />
    )

    await user.click(screen.getByRole('button', { name: '스키마 생성' }))
    expect(onCreateDefaultSchema).toHaveBeenCalledTimes(1)

    rerender(
      <DocumentPropertiesSection
        document={{
          documentName: 'guide.md',
          content: '# Guide',
          isMarkdownDocument: true
        }}
        schemaResult={{
          exists: true,
          path: 'C:/wiki/.wiki-editor/frontmatter.json',
          schema: null,
          error: 'frontmatter.json 구문 오류: Unexpected token'
        }}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={onCreateDefaultSchema}
      />
    )

    expect(screen.getByText(/frontmatter\.json 구문 오류/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '스키마 생성' })).not.toBeInTheDocument()
  })

  it('adds and removes frontmatter blocks and displays n/m and ⚠ k badges', async () => {
    const user = userEvent.setup()

    function StatefulHarness() {
      const [content, setContent] = useState('# Title\n\nBody text')
      return (
        <DocumentPropertiesSection
          document={{
            documentName: 'guide.md',
            documentKey: 'c:/wiki/guide.md',
            content,
            isMarkdownDocument: true
          }}
          schemaResult={makeSchemaResult(createDefaultFrontmatterSchema())}
          isExpanded
          onToggleExpanded={vi.fn()}
          onChangeContent={setContent}
          onCreateDefaultSchema={vi.fn()}
        />
      )
    }

    render(<StatefulHarness />)
    const section = screen.getByRole('region', { name: '문서 속성' })
    expect(within(section).getByText('0/5')).toBeInTheDocument()
    expect(within(section).queryByLabelText(/유효성 경고/)).not.toBeInTheDocument()

    // Create frontmatter block via '+ 속성 추가'
    await user.click(within(section).getByRole('button', { name: '+ 속성 추가' }))
    expect(within(section).getByLabelText('상태')).toBeInTheDocument()
    // status is required -> 1 warning badge appears
    expect(within(section).getByLabelText('유효성 경고 1건')).toHaveTextContent('⚠ 1')

    // Select status -> warning clears and n/m updates to 1/5
    await user.selectOptions(within(section).getByLabelText('상태'), 'in-progress')
    expect(within(section).getByText('1/5')).toBeInTheDocument()
    expect(within(section).queryByLabelText(/유효성 경고/)).not.toBeInTheDocument()

    // Remove frontmatter block via '프론트매터 제거'
    await user.click(within(section).getByRole('button', { name: '프론트매터 제거' }))
    expect(within(section).getByRole('button', { name: '+ 속성 추가' })).toBeInTheDocument()
    expect(within(section).getByText('0/5')).toBeInTheDocument()
  })

  it('edits all 6 field types, enforces allowCustom, preserves unknown fields & comments, and guards YAML syntax errors', async () => {
    const user = userEvent.setup()
    const initialDoc = [
      '---',
      '# top comment preserved',
      'status: todo',
      'customOwner: platform-team',
      'nestedMeta:',
      '  team: core',
      '---',
      '# Heading',
      '',
      'Body'
    ].join('\n')

    let latestContent = initialDoc
    function StatefulHarness() {
      const [content, setContent] = useState(initialDoc)
      latestContent = content
      return (
        <DocumentPropertiesSection
          document={{
            documentName: 'spec.md',
            documentKey: 'c:/wiki/spec.md',
            content,
            isMarkdownDocument: true
          }}
          schemaResult={makeSchemaResult(FULL_SCHEMA)}
          isExpanded
          onToggleExpanded={vi.fn()}
          onChangeContent={setContent}
          onCreateDefaultSchema={vi.fn()}
        />
      )
    }

    render(<StatefulHarness />)
    const section = screen.getByRole('region', { name: '문서 속성' })
    expect(within(section).getByText('1/7')).toBeInTheDocument()

    // 1. select
    await user.selectOptions(within(section).getByLabelText('상태'), 'done')
    // 2. number (including decimal draft '1.5')
    await user.type(within(section).getByLabelText('우선순위'), '1.5')
    // 3. boolean
    await user.click(within(section).getByRole('checkbox', { name: '공개 여부' }))
    // 4. date
    fireEvent.change(within(section).getByLabelText('마감일'), {
      target: { value: '2026-12-31' }
    })
    // 5. text
    await user.type(within(section).getByLabelText('담당자'), '@alice')
    // 6a. multi-select with allowCustom: true -> suggestion button + Enter custom chip
    await user.click(within(section).getByRole('button', { name: '+ docs' }))
    const labelInput = within(section).getByLabelText('라벨')
    await user.type(labelInput, 'urgent{Enter}')
    expect(within(section).getByText('urgent')).toBeInTheDocument()
    // 6b. multi-select with allowCustom: false -> no free-text input, option buttons only
    expect(within(section).queryByLabelText('플랫폼')).not.toBeInTheDocument()
    await user.click(within(section).getByRole('button', { name: '+ web' }))

    expect(within(section).getByText('7/7')).toBeInTheDocument()
    expect(latestContent).toContain('# top comment preserved')
    expect(latestContent).toContain('customOwner: platform-team')
    expect(latestContent).toContain('nestedMeta:\n  team: core')
    expect(latestContent).toContain('status: done')
    expect(latestContent).toContain('priority: 1.5')
    expect(latestContent).toContain('published: true')
    expect(latestContent).toContain('dueDate: 2026-12-31')
    expect(latestContent).toContain('assignee: "@alice"')
    expect(latestContent).toContain('- docs')
    expect(latestContent).toContain('- urgent')
    expect(latestContent).toContain('- web')

    // Unknown fields collapsible preview
    const unknownToggle = within(section).getByRole('button', { name: '미정의 필드 (2) · 보존' })
    expect(unknownToggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(unknownToggle)
    expect(unknownToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(section).getByText('customOwner')).toBeInTheDocument()
    expect(within(section).getByText('platform-team')).toBeInTheDocument()
    expect(within(section).getByText('nestedMeta')).toBeInTheDocument()

    // Remove one chip and clear boolean
    await user.click(within(section).getByRole('button', { name: '라벨 urgent 제거' }))
    expect(within(section).queryByText('urgent')).not.toBeInTheDocument()
    await user.click(within(section).getByRole('button', { name: '공개 여부 값 지우기' }))
    expect(within(section).getByText('6/7')).toBeInTheDocument()
  })

  it('displays non-blocking soft warnings for field violations and disables GUI mutations on YAML syntax errors', () => {
    const invalidFieldsDoc = [
      '---',
      'status: invalid-choice',
      'priority: not-a-number',
      'dueDate: 2026-02-30',
      'platforms:',
      '  - mobile',
      '---',
      '# Body'
    ].join('\n')

    const { rerender } = render(
      <DocumentPropertiesSection
        document={{
          documentName: 'bad.md',
          content: invalidFieldsDoc,
          isMarkdownDocument: true
        }}
        schemaResult={makeSchemaResult(FULL_SCHEMA)}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
      />
    )

    const section = screen.getByRole('region', { name: '문서 속성' })
    expect(within(section).getByLabelText('유효성 경고 4건')).toHaveTextContent('⚠ 4')
    expect(within(section).getByText(/허용되지 않은 옵션\("invalid-choice"\)/)).toBeInTheDocument()
    expect(within(section).getByText(/유효한 숫자여야 합니다/)).toBeInTheDocument()
    expect(within(section).getByText(/실존하는 YYYY-MM-DD 형식/)).toBeInTheDocument()
    expect(within(section).getByText(/허용되지 않은 옵션\(mobile\)/)).toBeInTheDocument()

    // YAML syntax error protects raw block from GUI edits
    const onChangeContent = vi.fn()
    rerender(
      <DocumentPropertiesSection
        document={{
          documentName: 'broken.md',
          content: '---\nbroken: [unclosed\n---\n# Body',
          isMarkdownDocument: true
        }}
        schemaResult={makeSchemaResult(FULL_SCHEMA)}
        isExpanded
        onToggleExpanded={vi.fn()}
        onChangeContent={onChangeContent}
        onCreateDefaultSchema={vi.fn()}
      />
    )

    expect(within(section).getByLabelText('유효성 경고 1건')).toHaveTextContent('⚠ 1')
    expect(within(section).getByText('YAML 구문 오류 · 미파싱 원문 보호')).toBeInTheDocument()
    expect(within(section).getByText(/Flow sequence/)).toBeInTheDocument()
    expect(within(section).getByText(/GUI 속성 편집이 비활성화되었습니다/)).toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: '프론트매터 제거' })).not.toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: '+ 속성 추가' })).not.toBeInTheDocument()
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('renders ⚙ header button without toggling accordion and exposes schema management / raw JSON recovery triggers', async () => {
    const user = userEvent.setup()
    const onToggleExpanded = vi.fn()
    const onOpenSchemaModal = vi.fn()
    const onOpenSchemaRawJson = vi.fn()

    const { rerender } = render(
      <DocumentPropertiesSection
        document={{
          documentName: 'guide.md',
          content: '# Guide',
          isMarkdownDocument: true
        }}
        schemaResult={{
          exists: false,
          path: 'C:/wiki/.wiki-editor/frontmatter.json',
          schema: null
        }}
        isExpanded
        onToggleExpanded={onToggleExpanded}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
        onOpenSchemaModal={onOpenSchemaModal}
        onOpenSchemaRawJson={onOpenSchemaRawJson}
      />
    )

    const section = screen.getByRole('region', { name: '문서 속성' })
    const headerManageBtn = within(section).getAllByRole('button', { name: '스키마 관리' })[0]
    await user.click(headerManageBtn)
    expect(onOpenSchemaModal).toHaveBeenCalledTimes(1)
    expect(onToggleExpanded).not.toHaveBeenCalled()

    // Missing schema notice also offers 스키마 관리
    const noticeButtons = within(section).getAllByRole('button', { name: '스키마 관리' })
    expect(noticeButtons).toHaveLength(2)
    await user.click(noticeButtons[1])
    expect(onOpenSchemaModal).toHaveBeenCalledTimes(2)

    // Schema error notice offers 스키마 관리 & JSON 파일로 열기 recovery entry points
    rerender(
      <DocumentPropertiesSection
        document={{
          documentName: 'guide.md',
          content: '---\nstatus: todo\n---\n# Guide',
          isMarkdownDocument: true
        }}
        schemaResult={{
          exists: true,
          path: 'C:/wiki/.wiki-editor/frontmatter.json',
          schema: null,
          error: 'frontmatter.json 구문 오류: Unexpected token'
        }}
        isExpanded
        onToggleExpanded={onToggleExpanded}
        onChangeContent={vi.fn()}
        onCreateDefaultSchema={vi.fn()}
        onOpenSchemaModal={onOpenSchemaModal}
        onOpenSchemaRawJson={onOpenSchemaRawJson}
      />
    )

    const errorButtons = within(section).getAllByRole('button', { name: '스키마 관리' })
    expect(errorButtons).toHaveLength(2)
    await user.click(errorButtons[1])
    expect(onOpenSchemaModal).toHaveBeenCalledTimes(3)

    await user.click(within(section).getByRole('button', { name: 'JSON 파일로 열기' }))
    expect(onOpenSchemaRawJson).toHaveBeenCalledTimes(1)
  })

  it('merges workspace custom values with schema options for allowCustom multi-select suggestions and requests fresh values on focus', async () => {
    const user = userEvent.setup()
    const onRequestFieldValues = vi.fn()
    let latestContent = '---\nlabels:\n  - docs\n---\n# Guide'

    function StatefulHarness() {
      const [content, setContent] = useState(latestContent)
      latestContent = content
      return (
        <DocumentPropertiesSection
          document={{
            documentName: 'guide.md',
            documentKey: 'c:/wiki/guide.md',
            content,
            isMarkdownDocument: true
          }}
          schemaResult={makeSchemaResult(FULL_SCHEMA)}
          fieldValuesByKey={{
            labels: ['backend', 'docs', 'security-audit', 'urgent-fix'],
            platforms: ['web', 'desktop', 'should-not-appear']
          }}
          onRequestFieldValues={onRequestFieldValues}
          isExpanded
          onToggleExpanded={vi.fn()}
          onChangeContent={setContent}
          onCreateDefaultSchema={vi.fn()}
        />
      )
    }

    render(<StatefulHarness />)
    const section = screen.getByRole('region', { name: '문서 속성' })
    const labelSuggestions = within(section).getByLabelText('라벨 제안')
    expect(
      within(labelSuggestions)
        .getAllByRole('button')
        .map((btn) => btn.textContent)
    ).toEqual(['+ backend', '+ security-audit', '+ urgent-fix'])

    // allowCustom: false field ignores extra suggested values
    const platformSuggestions = within(section).getByLabelText('플랫폼 제안')
    expect(within(platformSuggestions).queryByRole('button', { name: '+ should-not-appear' })).not.toBeInTheDocument()

    // Focusing input requests live refresh and typing filters both schema and custom values
    const labelInput = within(section).getByLabelText('라벨')
    await user.click(labelInput)
    expect(onRequestFieldValues).toHaveBeenCalled()

    await user.type(labelInput, 'audit')
    expect(within(labelSuggestions).getByRole('button', { name: '+ security-audit' })).toBeInTheDocument()
    expect(within(labelSuggestions).queryByRole('button', { name: '+ backend' })).not.toBeInTheDocument()

    await user.click(within(labelSuggestions).getByRole('button', { name: '+ security-audit' }))
    expect(latestContent).toContain('- security-audit')
  })
})
