import { describe, expect, it } from 'vitest'
import {
  collectAllowCustomMultiSelectFields,
  extractFrontmatterSummary,
  type FrontmatterFieldDefinition,
  type FrontmatterFilterCondition,
  isExcludedFrontmatterRelativePath,
  isFrontmatterDocumentFileName,
  matchesFrontmatterConditions,
  parseFrontmatterDocument,
  type WorkspaceFrontmatterSchema
} from './frontmatter'
import {
  createWorkspaceSearchSortPlan,
  type FrontmatterSortableSearchEntry,
  type WorkspaceSearchSortSpec
} from './search'

const TEST_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'status',
      label: '상태',
      type: 'select',
      showInSearchBadge: true,
      options: [
        { value: 'todo' },
        { value: 'in-progress' },
        { value: 'review' },
        { value: 'done' }
      ]
    },
    {
      key: 'priority',
      label: '우선순위',
      type: 'select',
      showInSearchBadge: true,
      options: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }]
    },
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      showInSearchBadge: true,
      options: [{ value: 'backend' }, { value: 'security' }]
    },
    {
      key: 'assignee',
      label: '담당자',
      type: 'text'
    },
    {
      key: 'points',
      label: '스토리 포인트',
      type: 'number'
    },
    {
      key: 'dueDate',
      label: '마감일',
      type: 'date'
    },
    {
      key: 'archived',
      label: '보관',
      type: 'boolean'
    }
  ]
}

function evalDoc(markdown: string, conditions: FrontmatterFilterCondition[]): boolean {
  const parsed = parseFrontmatterDocument(markdown, TEST_SCHEMA)
  return matchesFrontmatterConditions(parsed.values, conditions, TEST_SCHEMA)
}

describe('frontmatter filter engine', () => {
  it('evaluates select operators (in, not-in, is-empty) accurately', () => {
    const todoDoc = '---\nstatus: todo\n---\n# Todo'
    const doneDoc = '---\nstatus: done\n---\n# Done'
    const emptyDoc = '---\nstatus: ""\n---\n# Empty'
    const plainDoc = '# No frontmatter'

    expect(evalDoc(todoDoc, [{ fieldKey: 'status', operator: 'in', values: ['todo', 'in-progress'] }])).toBe(
      true
    )
    expect(evalDoc(doneDoc, [{ fieldKey: 'status', operator: 'in', values: ['todo', 'in-progress'] }])).toBe(
      false
    )
    expect(evalDoc(plainDoc, [{ fieldKey: 'status', operator: 'in', values: ['todo'] }])).toBe(false)
    expect(evalDoc(todoDoc, [{ fieldKey: 'status', operator: 'in', values: [] }])).toBe(false)

    expect(evalDoc(todoDoc, [{ fieldKey: 'status', operator: 'not-in', values: ['done'] }])).toBe(true)
    expect(evalDoc(doneDoc, [{ fieldKey: 'status', operator: 'not-in', values: ['done'] }])).toBe(false)
    expect(evalDoc(plainDoc, [{ fieldKey: 'status', operator: 'not-in', values: ['done'] }])).toBe(true)

    expect(evalDoc(emptyDoc, [{ fieldKey: 'status', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(plainDoc, [{ fieldKey: 'status', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(todoDoc, [{ fieldKey: 'status', operator: 'is-empty' }])).toBe(false)
  })

  it('evaluates multi-select operators (all-of, any-of, none-of, is-empty) accurately', () => {
    const bothDoc = '---\nlabels: [backend, security, custom]\n---\n'
    const backendOnlyDoc = '---\nlabels: [backend]\n---\n'
    const emptyListDoc = '---\nlabels: []\n---\n'
    const plainDoc = '# Plain'
    const malformedDoc = '---\nlabels: not-an-array\n---\n'

    expect(
      evalDoc(bothDoc, [{ fieldKey: 'labels', operator: 'all-of', values: ['backend', 'security'] }])
    ).toBe(true)
    expect(
      evalDoc(backendOnlyDoc, [
        { fieldKey: 'labels', operator: 'all-of', values: ['backend', 'security'] }
      ])
    ).toBe(false)
    expect(
      evalDoc(malformedDoc, [{ fieldKey: 'labels', operator: 'all-of', values: ['not-an-array'] }])
    ).toBe(false)
    expect(
      evalDoc(bothDoc, [{ fieldKey: 'labels', operator: 'all-of', values: [] }])
    ).toBe(false)
    expect(
      evalDoc(plainDoc, [{ fieldKey: 'labels', operator: 'all-of' }])
    ).toBe(false)

    expect(
      evalDoc(backendOnlyDoc, [
        { fieldKey: 'labels', operator: 'any-of', values: ['backend', 'security'] }
      ])
    ).toBe(true)
    expect(
      evalDoc(emptyListDoc, [
        { fieldKey: 'labels', operator: 'any-of', values: ['backend', 'security'] }
      ])
    ).toBe(false)

    expect(
      evalDoc(backendOnlyDoc, [{ fieldKey: 'labels', operator: 'none-of', values: ['security'] }])
    ).toBe(true)
    expect(
      evalDoc(bothDoc, [{ fieldKey: 'labels', operator: 'none-of', values: ['security'] }])
    ).toBe(false)
    expect(
      evalDoc(plainDoc, [{ fieldKey: 'labels', operator: 'none-of', values: ['security'] }])
    ).toBe(true)

    expect(evalDoc(emptyListDoc, [{ fieldKey: 'labels', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(plainDoc, [{ fieldKey: 'labels', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(backendOnlyDoc, [{ fieldKey: 'labels', operator: 'is-empty' }])).toBe(false)
  })

  it('evaluates text operators (case-insensitive contains, exact equals, is-empty)', () => {
    const doc = '---\nassignee: "Alice Kim"\n---\n'
    const blankDoc = '---\nassignee: "   "\n---\n'
    const plainDoc = '# Plain'

    expect(evalDoc(doc, [{ fieldKey: 'assignee', operator: 'contains', value: 'alice' }])).toBe(true)
    expect(evalDoc(doc, [{ fieldKey: 'assignee', operator: 'contains', value: 'KIM' }])).toBe(true)
    expect(evalDoc(doc, [{ fieldKey: 'assignee', operator: 'contains', value: 'bob' }])).toBe(false)
    expect(evalDoc(plainDoc, [{ fieldKey: 'assignee', operator: 'contains', value: '' }])).toBe(false)

    expect(evalDoc(doc, [{ fieldKey: 'assignee', operator: 'equals', value: 'Alice Kim' }])).toBe(true)
    expect(evalDoc(doc, [{ fieldKey: 'assignee', operator: 'equals', value: 'alice kim' }])).toBe(false)

    expect(evalDoc(blankDoc, [{ fieldKey: 'assignee', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(plainDoc, [{ fieldKey: 'assignee', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(doc, [{ fieldKey: 'assignee', operator: 'is-empty' }])).toBe(false)
  })

  it('evaluates number and date operators (equals, gte, lte, between, is-empty) including zero and calendar validity', () => {
    const zeroDoc = '---\npoints: 0\ndueDate: 2026-11-20\n---\n'
    const midDoc = '---\npoints: 5\ndueDate: 2026-11-25\n---\n'
    const badTypesDoc = '---\npoints: "5"\ndueDate: 2026-02-29\n---\n'
    const plainDoc = '# Plain'

    expect(evalDoc(zeroDoc, [{ fieldKey: 'points', operator: 'equals', value: 0 }])).toBe(true)
    expect(evalDoc(zeroDoc, [{ fieldKey: 'points', operator: 'is-empty' }])).toBe(false)
    expect(evalDoc(plainDoc, [{ fieldKey: 'points', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(midDoc, [{ fieldKey: 'points', operator: 'gte', value: 5 }])).toBe(true)
    expect(evalDoc(midDoc, [{ fieldKey: 'points', operator: 'lte', value: 5 }])).toBe(true)
    expect(evalDoc(midDoc, [{ fieldKey: 'points', operator: 'between', min: 1, max: 5 }])).toBe(true)
    expect(evalDoc(midDoc, [{ fieldKey: 'points', operator: 'between', min: 6, max: 10 }])).toBe(false)
    expect(evalDoc(midDoc, [{ fieldKey: 'points', operator: 'between', min: 10, max: 1 }])).toBe(false)
    expect(evalDoc(badTypesDoc, [{ fieldKey: 'points', operator: 'equals', value: 5 }])).toBe(false)

    expect(evalDoc(zeroDoc, [{ fieldKey: 'dueDate', operator: 'equals', value: '2026-11-20' }])).toBe(
      true
    )
    expect(evalDoc(midDoc, [{ fieldKey: 'dueDate', operator: 'gte', value: '2026-11-20' }])).toBe(true)
    expect(evalDoc(midDoc, [{ fieldKey: 'dueDate', operator: 'lte', value: '2026-11-25' }])).toBe(true)
    expect(
      evalDoc(midDoc, [
        { fieldKey: 'dueDate', operator: 'between', min: '2026-11-20', max: '2026-11-30' }
      ])
    ).toBe(true)
    expect(
      evalDoc(zeroDoc, [
        { fieldKey: 'dueDate', operator: 'between', min: '2026-11-21', max: '2026-11-30' }
      ])
    ).toBe(false)
    expect(
      evalDoc(badTypesDoc, [{ fieldKey: 'dueDate', operator: 'equals', value: '2026-02-29' }])
    ).toBe(false)
    expect(evalDoc(plainDoc, [{ fieldKey: 'dueDate', operator: 'is-empty' }])).toBe(true)
  })

  it('evaluates boolean operators (equals, is-empty) including false and combines conditions with AND', () => {
    const falseDoc = '---\nstatus: in-progress\narchived: false\nlabels: [security]\ndueDate: 2026-11-22\n---\n'
    const trueDoc = '---\nstatus: in-progress\narchived: true\nlabels: [security]\ndueDate: 2026-11-22\n---\n'
    const plainDoc = '# Plain'

    expect(evalDoc(falseDoc, [{ fieldKey: 'archived', operator: 'equals', value: false }])).toBe(true)
    expect(evalDoc(falseDoc, [{ fieldKey: 'archived', operator: 'is-empty' }])).toBe(false)
    expect(evalDoc(plainDoc, [{ fieldKey: 'archived', operator: 'is-empty' }])).toBe(true)
    expect(evalDoc(trueDoc, [{ fieldKey: 'archived', operator: 'equals', value: true }])).toBe(true)

    const combined: FrontmatterFilterCondition[] = [
      { fieldKey: 'status', operator: 'in', values: ['in-progress'] },
      { fieldKey: 'labels', operator: 'any-of', values: ['security'] },
      { fieldKey: 'dueDate', operator: 'lte', value: '2026-11-25' },
      { fieldKey: 'archived', operator: 'equals', value: false }
    ]
    expect(evalDoc(falseDoc, combined)).toBe(true)
    expect(evalDoc(trueDoc, combined)).toBe(false)

    // Unknown field or missing schema safely rejects non-empty conditions
    expect(
      matchesFrontmatterConditions(
        { status: 'todo' },
        [{ fieldKey: 'missingField', operator: 'is-empty' }],
        TEST_SCHEMA
      )
    ).toBe(false)
    expect(
      matchesFrontmatterConditions(
        { status: 'todo' },
        [{ fieldKey: 'status', operator: 'in', values: ['todo'] }],
        null
      )
    ).toBe(false)
    // Unsupported operator for field type returns false
    const selectField = TEST_SCHEMA.fields[0] as FrontmatterFieldDefinition
    expect(
      matchesFrontmatterConditions(
        { status: 'todo' },
        [{ fieldKey: selectField.key, operator: 'contains', value: 'to' }],
        TEST_SCHEMA
      )
    ).toBe(false)
  })
})

function sortEntries(
  items: readonly FrontmatterSortableSearchEntry[],
  sort: WorkspaceSearchSortSpec | undefined,
  schema: WorkspaceFrontmatterSchema | null | undefined = TEST_SCHEMA
): string[] {
  return [...items].sort(createWorkspaceSearchSortPlan(sort, schema).compare).map((i) => i.relativePath)
}

describe('frontmatter sort engine, summary extraction, and custom value collection', () => {
  it('sorts by path asc/desc and by select option declaration order with out-of-schema after options and empty always last', () => {
    const items: FrontmatterSortableSearchEntry[] = [
      { relativePath: 'd-empty.md', nameMatches: [], values: {} },
      { relativePath: 'b-done.md', nameMatches: [], values: { status: 'done' } },
      { relativePath: 'c-custom.md', nameMatches: [], values: { status: 'legacy' } },
      { relativePath: 'a-todo.md', nameMatches: [], values: { status: 'todo' } },
      { relativePath: 'e-progress-2.md', nameMatches: [], values: { status: 'in-progress' } },
      { relativePath: 'b-progress-1.md', nameMatches: [], values: { status: 'in-progress' } },
      { relativePath: 'a-empty.md', nameMatches: [], values: { status: '' } }
    ]

    expect(sortEntries(items, { by: 'frontmatter', fieldKey: 'status', direction: 'asc' })).toEqual([
      'a-todo.md',
      'b-progress-1.md',
      'e-progress-2.md',
      'b-done.md',
      'c-custom.md',
      'a-empty.md',
      'd-empty.md'
    ])

    expect(sortEntries(items, { by: 'frontmatter', fieldKey: 'status', direction: 'desc' })).toEqual([
      'b-done.md',
      'b-progress-1.md',
      'e-progress-2.md',
      'a-todo.md',
      'c-custom.md',
      'a-empty.md',
      'd-empty.md'
    ])

    expect(sortEntries(items, { by: 'path', direction: 'desc' })).toEqual([
      'e-progress-2.md',
      'd-empty.md',
      'c-custom.md',
      'b-progress-1.md',
      'b-done.md',
      'a-todo.md',
      'a-empty.md'
    ])
  })

  it('sorts number, date, text, multi-select, and boolean fields with empty values always last in both asc and desc', () => {
    const numItems: FrontmatterSortableSearchEntry[] = [
      { relativePath: 'empty.md', nameMatches: [], values: {} },
      { relativePath: 'ten.md', nameMatches: [], values: { points: 10 } },
      { relativePath: 'zero.md', nameMatches: [], values: { points: 0 } },
      { relativePath: 'two.md', nameMatches: [], values: { points: 2 } },
      { relativePath: 'invalid.md', nameMatches: [], values: { points: '5' } }
    ]
    expect(sortEntries(numItems, { by: 'frontmatter', fieldKey: 'points', direction: 'asc' })).toEqual([
      'zero.md',
      'two.md',
      'ten.md',
      'empty.md',
      'invalid.md'
    ])
    expect(sortEntries(numItems, { by: 'frontmatter', fieldKey: 'points', direction: 'desc' })).toEqual([
      'ten.md',
      'two.md',
      'zero.md',
      'empty.md',
      'invalid.md'
    ])

    const dateItems: FrontmatterSortableSearchEntry[] = [
      { relativePath: 'none.md', nameMatches: [], values: {} },
      { relativePath: 'late.md', nameMatches: [], values: { dueDate: '2026-12-01' } },
      { relativePath: 'early.md', nameMatches: [], values: { dueDate: '2026-01-15' } },
      { relativePath: 'bad.md', nameMatches: [], values: { dueDate: '2026-02-29' } }
    ]
    expect(sortEntries(dateItems, { by: 'frontmatter', fieldKey: 'dueDate', direction: 'asc' })).toEqual([
      'early.md',
      'late.md',
      'bad.md',
      'none.md'
    ])

    const boolItems: FrontmatterSortableSearchEntry[] = [
      { relativePath: 'unset.md', nameMatches: [], values: {} },
      { relativePath: 'true.md', nameMatches: [], values: { archived: true } },
      { relativePath: 'false.md', nameMatches: [], values: { archived: false } }
    ]
    expect(sortEntries(boolItems, { by: 'frontmatter', fieldKey: 'archived', direction: 'asc' })).toEqual([
      'false.md',
      'true.md',
      'unset.md'
    ])
    expect(sortEntries(boolItems, { by: 'frontmatter', fieldKey: 'archived', direction: 'desc' })).toEqual([
      'true.md',
      'false.md',
      'unset.md'
    ])

    const textAndTags: FrontmatterSortableSearchEntry[] = [
      { relativePath: 'c.md', nameMatches: [], values: { assignee: 'Charlie', labels: ['zeta'] } },
      { relativePath: 'a.md', nameMatches: [], values: { assignee: 'alice', labels: ['alpha', 'beta'] } },
      { relativePath: 'b.md', nameMatches: [], values: { assignee: 'Bob', labels: ['alpha'] } },
      { relativePath: 'd.md', nameMatches: [], values: { assignee: '', labels: [] } }
    ]
    expect(sortEntries(textAndTags, { by: 'frontmatter', fieldKey: 'assignee', direction: 'asc' })).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'd.md'
    ])
    expect(sortEntries(textAndTags, { by: 'frontmatter', fieldKey: 'labels', direction: 'asc' })).toEqual([
      'b.md',
      'a.md',
      'c.md',
      'd.md'
    ])
  })

  it('extracts frontmatterSummary prioritizing showInSearchBadge fields and falling back when none are marked', () => {
    expect(
      extractFrontmatterSummary(
        {
          status: 'todo',
          labels: ['backend', 'api'],
          assignee: 'Alice',
          points: 0,
          archived: false
        },
        TEST_SCHEMA
      )
    ).toEqual({
      status: 'todo',
      labels: ['backend', 'api']
    })

    expect(extractFrontmatterSummary({}, TEST_SCHEMA)).toBeUndefined()

    const fallbackSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        { key: 'owner', label: '담당', type: 'text' },
        { key: 'hidden', label: '숨김', type: 'text', showInSearchBadge: false },
        { key: 'stage', label: '단계', type: 'select', options: [{ value: 'draft' }] },
        { key: 'count', label: '수량', type: 'number' },
        { key: 'extra', label: '추가', type: 'text' }
      ]
    }
    expect(
      extractFrontmatterSummary(
        {
          owner: 'Alice',
          hidden: 'secret',
          stage: 'draft',
          count: 0,
          extra: 'skipped-4th'
        },
        fallbackSchema
      )
    ).toEqual({
      owner: 'Alice',
      stage: 'draft',
      count: 0
    })
  })

  it('collects deduplicated sorted schema options and custom values for allowCustom multi-select fields and identifies eligible markdown paths', () => {
    const schemaWithMultipleMultiSelect: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        {
          key: 'labels',
          label: '라벨',
          type: 'multi-select',
          allowCustom: true,
          options: [{ value: 'security' }, { value: 'backend' }]
        },
        {
          key: 'strictTags',
          label: '고정 태그',
          type: 'multi-select',
          allowCustom: false,
          options: [{ value: 'core' }]
        },
        {
          key: 'areas',
          label: '영역',
          type: 'multi-select',
          allowCustom: true
        }
      ]
    }

    const targets = collectAllowCustomMultiSelectFields(schemaWithMultipleMultiSelect)
    expect(targets.map((f) => f.key)).toEqual(['labels', 'areas'])

    const filteredTargets = collectAllowCustomMultiSelectFields(schemaWithMultipleMultiSelect, [
      'labels',
      'strictTags'
    ])
    expect(filteredTargets.map((f) => f.key)).toEqual(['labels'])

    expect(isFrontmatterDocumentFileName('guide.md')).toBe(true)
    expect(isFrontmatterDocumentFileName('NOTE.MARKDOWN')).toBe(true)
    expect(isFrontmatterDocumentFileName('README')).toBe(true)
    expect(isFrontmatterDocumentFileName('.gitignore')).toBe(false)
    expect(isFrontmatterDocumentFileName('notes.txt')).toBe(false)
    expect(isFrontmatterDocumentFileName('frontmatter.json')).toBe(false)

    expect(isExcludedFrontmatterRelativePath('.wiki-editor/frontmatter.json')).toBe(true)
    expect(isExcludedFrontmatterRelativePath('.wiki-editor/notes.md')).toBe(true)
    expect(isExcludedFrontmatterRelativePath('docs/.git/note.md')).toBe(true)
    expect(isExcludedFrontmatterRelativePath('docs/README')).toBe(false)
  })
})
