import { describe, expect, it } from 'vitest'
import type { WorkspaceFrontmatterSchema } from '@shared/frontmatter'
import {
  buildConditionFromDraft,
  buildFilterSelectableOptions,
  createFilterEditDraft,
  cycleListboxIndex,
  DEFAULT_WORKSPACE_SEARCH_SORT,
  extractDisplaySummaryBadges,
  formatFilterChipLabel,
  parseSearchSortValue,
  reconcileFilterConditions,
  reconcileSearchSortSpec,
  serializeSearchSortSpec,
  upsertBadgeFilterCondition
} from './frontmatterFilterBar'

const SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'status',
      label: '상태',
      type: 'select',
      showInSearchBadge: true,
      options: [
        { value: 'todo', color: '#64748b' },
        { value: 'in-progress', color: '#2563eb' }
      ]
    },
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      showInSearchBadge: true,
      options: [{ value: 'backend', color: '#7c3aed' }]
    },
    {
      key: 'strictTags',
      label: '고정태그',
      type: 'multi-select',
      allowCustom: false,
      options: [{ value: 'core' }]
    },
    { key: 'score', label: '점수', type: 'number', showInSearchBadge: true },
    { key: 'published', label: '공개 여부', type: 'boolean', showInSearchBadge: true },
    { key: 'dueDate', label: '마감일', type: 'date' },
    { key: 'assignee', label: '담당자', type: 'text' }
  ]
}

describe('frontmatterFilterBar utils', () => {
  it('serializes, parses, and reconciles sort specs and conditions against schema', () => {
    expect(serializeSearchSortSpec(DEFAULT_WORKSPACE_SEARCH_SORT)).toBe('path:asc')
    expect(
      serializeSearchSortSpec({ by: 'frontmatter', fieldKey: 'status', direction: 'desc' })
    ).toBe('frontmatter:desc:status')

    expect(parseSearchSortValue('path:asc')).toEqual(DEFAULT_WORKSPACE_SEARCH_SORT)
    expect(parseSearchSortValue('frontmatter:asc:score')).toEqual({
      by: 'frontmatter',
      fieldKey: 'score',
      direction: 'asc'
    })

    expect(
      reconcileSearchSortSpec({ by: 'frontmatter', fieldKey: 'missing', direction: 'asc' }, SCHEMA)
    ).toEqual(DEFAULT_WORKSPACE_SEARCH_SORT)
    expect(
      reconcileSearchSortSpec({ by: 'frontmatter', fieldKey: 'status', direction: 'desc' }, SCHEMA)
    ).toEqual({ by: 'frontmatter', fieldKey: 'status', direction: 'desc' })

    const reconciled = reconcileFilterConditions(
      [
        { fieldKey: 'status', operator: 'in', values: ['todo'] },
        { fieldKey: 'status', operator: 'between', min: 1, max: 2 },
        { fieldKey: 'removed', operator: 'is-empty' }
      ],
      SCHEMA
    )
    expect(reconciled).toEqual([{ fieldKey: 'status', operator: 'in', values: ['todo'] }])
  })

  it('formats active filter chip labels across field types and operators', () => {
    const byKey = new Map(SCHEMA.fields.map((f) => [f.key, f]))
    expect(
      formatFilterChipLabel({ fieldKey: 'status', operator: 'is-empty' }, byKey.get('status')!)
    ).toBe('상태 · 비어 있음')
    expect(
      formatFilterChipLabel(
        { fieldKey: 'status', operator: 'not-in', values: ['todo'] },
        byKey.get('status')!
      )
    ).toBe('상태 (제외): todo')
    expect(
      formatFilterChipLabel(
        { fieldKey: 'labels', operator: 'all-of', values: ['backend', 'custom'] },
        byKey.get('labels')!
      )
    ).toBe('라벨 (모두): backend, custom')
    expect(
      formatFilterChipLabel(
        { fieldKey: 'score', operator: 'between', min: 1, max: 5 },
        byKey.get('score')!
      )
    ).toBe('점수: 1 ~ 5')
    expect(
      formatFilterChipLabel(
        { fieldKey: 'published', operator: 'equals', value: false },
        byKey.get('published')!
      )
    ).toBe('공개 여부: 아니오')
    expect(
      formatFilterChipLabel(
        { fieldKey: 'assignee', operator: 'contains', value: 'kim' },
        byKey.get('assignee')!
      )
    ).toBe('담당자 포함 "kim"')
  })

  it('merges selectable options preserving schema order, allowCustom live values, and existing selections', () => {
    const labelsField = SCHEMA.fields[1]
    const strictField = SCHEMA.fields[2]

    expect(
      buildFilterSelectableOptions(
        labelsField,
        ['alpha', 'backend', 'zebra'],
        ['selected-old']
      )
    ).toEqual([
      { value: 'backend', color: '#7c3aed' },
      { value: 'alpha' },
      { value: 'zebra' },
      { value: 'selected-old' }
    ])

    expect(
      buildFilterSelectableOptions(strictField, ['should-ignore'])
    ).toEqual([{ value: 'core' }])
  })

  it('extracts display summary badges in schema order and upserts badge conditions cleanly', () => {
    const badges = extractDisplaySummaryBadges(
      {
        published: true,
        labels: ['backend', 'custom'],
        status: 'in-progress',
        score: 4
      },
      SCHEMA
    )
    expect(badges.map((b) => ({ id: b.id, displayText: b.displayText, color: b.color }))).toEqual([
      { id: 'status:in-progress', displayText: 'in-progress', color: '#2563eb' },
      { id: 'labels:backend', displayText: 'backend', color: '#7c3aed' },
      { id: 'labels:custom', displayText: 'custom', color: undefined },
      { id: 'score:4', displayText: '점수: 4', color: undefined },
      { id: 'published:true', displayText: '공개 여부: 예', color: undefined }
    ])

    const statusField = SCHEMA.fields[0]
    const labelsField = SCHEMA.fields[1]
    const scoreField = SCHEMA.fields[3]

    const first = upsertBadgeFilterCondition([], statusField, 'in-progress')
    expect(first).toEqual({
      changed: true,
      nextConditions: [{ fieldKey: 'status', operator: 'in', values: ['in-progress'] }]
    })
    expect(upsertBadgeFilterCondition(first.nextConditions, statusField, 'in-progress').changed).toBe(
      false
    )

    const multi1 = upsertBadgeFilterCondition(first.nextConditions, labelsField, 'backend')
    const multi2 = upsertBadgeFilterCondition(multi1.nextConditions, labelsField, 'custom')
    expect(multi2.nextConditions).toEqual([
      { fieldKey: 'status', operator: 'in', values: ['in-progress'] },
      { fieldKey: 'labels', operator: 'all-of', values: ['backend', 'custom'] }
    ])
    expect(upsertBadgeFilterCondition(multi2.nextConditions, labelsField, 'custom').changed).toBe(
      false
    )

    const scalar1 = upsertBadgeFilterCondition([], scoreField, 4)
    expect(scalar1.nextConditions).toEqual([{ fieldKey: 'score', operator: 'equals', value: 4 }])
    expect(upsertBadgeFilterCondition(scalar1.nextConditions, scoreField, 4).changed).toBe(false)
  })

  it('deduplicates repeated multi-select values in display summary badges', () => {
    const badges = extractDisplaySummaryBadges(
      {
        labels: ['backend', 'backend', 'custom', 'custom']
      },
      SCHEMA
    )
    expect(badges.map((badge) => badge.id)).toEqual(['labels:backend', 'labels:custom'])
  })

  it('cycles listbox indices cleanly and creates/validates popover filter drafts', () => {
    expect(cycleListboxIndex(0, 0, 1)).toBe(-1)
    expect(cycleListboxIndex(0, 3, -1)).toBe(2)
    expect(cycleListboxIndex(2, 3, 1)).toBe(0)

    const scoreField = SCHEMA.fields[3]
    const editDraft = createFilterEditDraft(
      { fieldKey: 'score', operator: 'between', min: 10, max: 2 },
      1
    )
    expect(editDraft.step).toBe('value')
    expect(buildConditionFromDraft(scoreField, editDraft)).toEqual({
      ok: false,
      error: '최솟값은 최댓값보다 클 수 없습니다.'
    })

    const validDraft = { ...editDraft, minValue: '2', maxValue: '10' }
    expect(buildConditionFromDraft(scoreField, validDraft)).toEqual({
      ok: true,
      condition: { fieldKey: 'score', operator: 'between', min: 2, max: 10 }
    })
  })
})
