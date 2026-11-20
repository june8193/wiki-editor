import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  FrontmatterSchemaLoadResult,
  WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { FrontmatterSchemaModal } from './FrontmatterSchemaModal'

function makeSchemaResult(
  schema: WorkspaceFrontmatterSchema | null,
  overrides: Partial<FrontmatterSchemaLoadResult> = {}
): FrontmatterSchemaLoadResult {
  return {
    exists: schema !== null,
    path: 'C:/wiki/.wiki-editor/frontmatter.json',
    schema,
    ...overrides
  }
}

describe('FrontmatterSchemaModal', () => {
  it('supports adding, editing, reordering, and deleting all 6 field types, options, badge colors, flags, and allowCustom', async () => {
    const user = userEvent.setup()
    const savedSchemas: WorkspaceFrontmatterSchema[] = []
    const onSaveSchema = vi.fn(async (next: WorkspaceFrontmatterSchema) => {
      savedSchemas.push(next)
      return makeSchemaResult(next)
    })
    const onClose = vi.fn()

    const initialSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        {
          key: 'status',
          label: '상태',
          type: 'select',
          required: true,
          showInSearchBadge: true,
          options: [
            { value: 'todo', color: '#64748b' },
            { value: 'done', color: '#16a34a' }
          ]
        },
        {
          key: 'obsolete',
          label: '제거대상',
          type: 'text'
        }
      ]
    }

    render(
      <FrontmatterSchemaModal
        schemaResult={makeSchemaResult(initialSchema)}
        onSaveSchema={onSaveSchema}
        onOpenRawJson={vi.fn()}
        onClose={onClose}
      />
    )

    // Delete '제거대상' field
    const obsoleteCard = screen.getByRole('group', { name: '필드 제거대상' })
    await user.click(within(obsoleteCard).getByRole('button', { name: '필드 삭제' }))
    expect(screen.queryByRole('group', { name: '필드 제거대상' })).not.toBeInTheDocument()

    // Edit 'status' select options: add 'review', set color, move 'review' up before 'done'
    const statusCard = screen.getByRole('group', { name: '필드 상태' })
    await user.click(within(statusCard).getByRole('button', { name: '+ 옵션 추가' }))
    const option3 = within(statusCard).getByRole('group', { name: '옵션 3' })
    await user.type(within(option3).getByLabelText('옵션 값'), 'review')
    fireEvent.change(within(option3).getByLabelText('옵션 색상 선택'), {
      target: { value: '#d97706' }
    })
    await user.click(within(option3).getByRole('button', { name: '옵션 위로 이동' }))

    // Add 5 more fields covering number, boolean, date, text, multi-select (with allowCustom)
    const addFieldSpecs = [
      {
        key: 'storyPoints',
        label: '포인트',
        type: 'number',
        placeholder: '1~13',
        required: false,
        showInSearchBadge: false
      },
      {
        key: 'published',
        label: '공개',
        type: 'boolean',
        placeholder: '',
        required: true,
        showInSearchBadge: true
      },
      {
        key: 'dueDate',
        label: '마감일',
        type: 'date',
        placeholder: '',
        required: false,
        showInSearchBadge: false
      },
      {
        key: 'assignee',
        label: '담당자',
        type: 'text',
        placeholder: '이름 또는 @핸들',
        required: false,
        showInSearchBadge: true
      },
      {
        key: 'labels',
        label: '라벨',
        type: 'multi-select',
        placeholder: '태그 입력',
        required: false,
        showInSearchBadge: true
      }
    ] as const

    for (let i = 0; i < addFieldSpecs.length; i += 1) {
      const spec = addFieldSpecs[i]
      await user.click(screen.getByRole('button', { name: '+ 필드 추가' }))
      const newCard = screen.getByRole('group', { name: `새 필드 ${i + 2}` })
      fireEvent.change(within(newCard).getByLabelText('키'), { target: { value: spec.key } })
      fireEvent.change(within(newCard).getByLabelText('라벨'), { target: { value: spec.label } })
      const renamedCard = screen.getByRole('group', { name: `필드 ${spec.label}` })
      await user.selectOptions(within(renamedCard).getByLabelText('타입'), spec.type)
      if (spec.placeholder) {
        fireEvent.change(within(renamedCard).getByLabelText('플레이스홀더'), {
          target: { value: spec.placeholder }
        })
      }
      if (spec.required) {
        await user.click(within(renamedCard).getByRole('checkbox', { name: '필수 항목' }))
      }
      if (spec.showInSearchBadge) {
        await user.click(within(renamedCard).getByRole('checkbox', { name: '검색 결과 배지 표시' }))
      }
      if (spec.type === 'multi-select') {
        await user.click(
          within(renamedCard).getByRole('checkbox', { name: '사용자 지정 값 허용 (allowCustom)' })
        )
        await user.click(within(renamedCard).getByRole('button', { name: '+ 옵션 추가' }))
        const optRow = within(renamedCard).getByRole('group', { name: '옵션 1' })
        fireEvent.change(within(optRow).getByLabelText('옵션 값'), {
          target: { value: 'security' }
        })
        fireEvent.change(within(optRow).getByLabelText('옵션 색상'), {
          target: { value: '#dc2626' }
        })
      }
    }

    // Move '담당자' up once (before '마감일')
    const assigneeCard = screen.getByRole('group', { name: '필드 담당자' })
    await user.click(within(assigneeCard).getByRole('button', { name: '필드 위로 이동' }))

    await user.click(screen.getByRole('button', { name: '저장' }))

    expect(onSaveSchema).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(savedSchemas[0]).toEqual({
      version: 1,
      fields: [
        {
          key: 'status',
          label: '상태',
          type: 'select',
          required: true,
          showInSearchBadge: true,
          options: [
            { value: 'todo', color: '#64748b' },
            { value: 'review', color: '#d97706' },
            { value: 'done', color: '#16a34a' }
          ]
        },
        {
          key: 'storyPoints',
          label: '포인트',
          type: 'number',
          placeholder: '1~13'
        },
        {
          key: 'published',
          label: '공개',
          type: 'boolean',
          required: true,
          showInSearchBadge: true
        },
        {
          key: 'assignee',
          label: '담당자',
          type: 'text',
          placeholder: '이름 또는 @핸들',
          showInSearchBadge: true
        },
        {
          key: 'dueDate',
          label: '마감일',
          type: 'date'
        },
        {
          key: 'labels',
          label: '라벨',
          type: 'multi-select',
          placeholder: '태그 입력',
          options: [{ value: 'security', color: '#dc2626' }],
          allowCustom: true,
          showInSearchBadge: true
        }
      ]
    })
  })

  it('shows inline validation errors before save for duplicate keys, invalid keys, empty labels/options, and allows recovery via starter template or raw JSON', async () => {
    const user = userEvent.setup()
    const onSaveSchema = vi.fn(async (schema: WorkspaceFrontmatterSchema) => makeSchemaResult(schema))
    const onOpenRawJson = vi.fn()

    const { rerender } = render(
      <FrontmatterSchemaModal
        schemaResult={makeSchemaResult({
          version: 1,
          fields: [{ key: 'status', label: '상태', type: 'select', options: [{ value: 'todo' }] }]
        })}
        onSaveSchema={onSaveSchema}
        onOpenRawJson={onOpenRawJson}
        onClose={vi.fn()}
      />
    )

    // Add duplicate key, invalid key, empty label, and empty option
    await user.click(screen.getByRole('button', { name: '+ 필드 추가' }))
    const dupCard = screen.getByRole('group', { name: '새 필드 2' })
    await user.type(within(dupCard).getByLabelText('키'), 'status')
    await user.selectOptions(within(dupCard).getByLabelText('타입'), 'multi-select')
    await user.click(within(dupCard).getByRole('button', { name: '+ 옵션 추가' }))

    await user.click(screen.getByRole('button', { name: '+ 필드 추가' }))
    const badKeyCard = screen.getByRole('group', { name: '새 필드 3' })
    await user.type(within(badKeyCard).getByLabelText('키'), 'bad key:1')
    await user.type(within(badKeyCard).getByLabelText('라벨'), '잘못된키')

    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(onSaveSchema).not.toHaveBeenCalled()

    expect(screen.getAllByText(/중복된 필드 키입니다/)).toHaveLength(2)
    expect(screen.getByText(/유효하지 않은 키입니다/)).toBeInTheDocument()
    expect(screen.getByText(/필드 라벨을 입력하세요/)).toBeInTheDocument()
    expect(screen.getByText(/옵션 값을 입력하세요/)).toBeInTheDocument()

    // Fix duplicate/empty fields, toggle allowCustom on multi-select so 0 options is valid, remove 3rd invalid field
    await user.click(within(screen.getByRole('group', { name: '필드 잘못된키' })).getByRole('button', { name: '필드 삭제' }))
    await user.clear(within(dupCard).getByLabelText('키'))
    await user.type(within(dupCard).getByLabelText('키'), 'labels')
    await user.type(within(dupCard).getByLabelText('라벨'), '라벨')
    const labelsCard = screen.getByRole('group', { name: '필드 라벨' })
    await user.click(within(labelsCard).getByRole('button', { name: '옵션 삭제' }))

    // Without allowCustom, saving multi-select with 0 options is blocked
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(onSaveSchema).not.toHaveBeenCalled()
    expect(within(labelsCard).getByText(/최소 1개 이상의 옵션을 추가하세요/)).toBeInTheDocument()

    // Enabling allowCustom makes 0 preset options valid
    await user.click(within(labelsCard).getByRole('checkbox', { name: '사용자 지정 값 허용 (allowCustom)' }))
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(onSaveSchema).toHaveBeenCalledTimes(1)

    // Broken disk schema shows clear error, allows loading starter template or opening raw JSON
    rerender(
      <FrontmatterSchemaModal
        schemaResult={makeSchemaResult(null, {
          exists: true,
          error: 'frontmatter.json 구문 오류: Unexpected token'
        })}
        onSaveSchema={onSaveSchema}
        onOpenRawJson={onOpenRawJson}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText(/frontmatter\.json 구문 오류: Unexpected token/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'JSON 파일로 열기' }))
    expect(onOpenRawJson).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '기본 템플릿 불러오기' }))
    expect(screen.getByRole('group', { name: '필드 상태' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '필드 우선순위' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '필드 라벨' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '필드 담당자' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '필드 마감일' })).toBeInTheDocument()
  })

  it('locks form inputs and dismissal while async save or raw JSON transition is pending and ignores post-unmount resolution', async () => {
    const user = userEvent.setup()
    let resolveSave!: (value: FrontmatterSchemaLoadResult) => void
    const onSaveSchema = vi.fn(
      () =>
        new Promise<FrontmatterSchemaLoadResult>((resolve) => {
          resolveSave = resolve
        })
    )
    let resolveRawJson!: () => void
    const onOpenRawJson = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRawJson = resolve
        })
    )
    const onClose = vi.fn()

    const validSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [{ key: 'status', label: '상태', type: 'text' }]
    }

    const { rerender, unmount } = render(
      <FrontmatterSchemaModal
        schemaResult={makeSchemaResult(validSchema)}
        onSaveSchema={onSaveSchema}
        onOpenRawJson={onOpenRawJson}
        onClose={onClose}
      />
    )

    // Pending raw JSON transition disables inputs, buttons, Esc, and backdrop dismissal
    const openJsonBtn = screen.getByRole('button', { name: 'JSON 파일로 열기' })
    await user.click(openJsonBtn)
    await user.click(openJsonBtn)
    expect(onOpenRawJson).toHaveBeenCalledTimes(1)

    const statusCard = screen.getByRole('group', { name: '필드 상태' })
    expect(within(statusCard).getByLabelText('키')).toBeDisabled()
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '취소' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '닫기' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '+ 필드 추가' })).toBeDisabled()

    await user.keyboard('{Escape}')
    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).not.toHaveBeenCalled()

    resolveRawJson()
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: '저장' })).toBeEnabled()
    })

    // Pending save locks field edits and ignores onClose if unmounted mid-save
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(onSaveSchema).toHaveBeenCalledTimes(1)
    expect(within(statusCard).getByLabelText('키')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'JSON 파일로 열기' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '닫기' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()

    // Unmount (e.g. workspace switch) mid-save must not invoke onClose when promise resolves
    rerender(
      <FrontmatterSchemaModal
        schemaResult={makeSchemaResult(validSchema)}
        onSaveSchema={onSaveSchema}
        onOpenRawJson={onOpenRawJson}
        onClose={onClose}
      />
    )
    unmount()
    resolveSave(makeSchemaResult(validSchema))
    await Promise.resolve()
    await Promise.resolve()
    expect(onClose).not.toHaveBeenCalled()
  })
})
