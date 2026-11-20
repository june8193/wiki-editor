import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  isFrontmatterOperatorForType,
  type FrontmatterFieldDefinition,
  type FrontmatterFilterCondition,
  type FrontmatterFilterOperator,
  type FrontmatterSchemaLoadResult,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import type { WorkspaceSearchSortSpec } from '@shared/search'
import { type DismissReason, useDismissable } from '../hooks/useDismissable'
import {
  createFilterEditDraft,
  createFilterFieldDraft,
  createInitialFilterAddDraft,
  type FilterPopoverDraft,
  formatFilterChipLabel,
  parseSearchSortValue,
  serializeSearchSortSpec
} from '../utils/frontmatterFilterBar'
import { FrontmatterFilterPopover } from './FrontmatterFilterPopover'

export interface FrontmatterFilterBarProps {
  workspaceRootPath: string | null
  schemaResult: FrontmatterSchemaLoadResult | null
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>
  conditions: readonly FrontmatterFilterCondition[]
  sort: WorkspaceSearchSortSpec
  onCreateDefaultSchema: () => void
  onOpenSchemaModal?: () => void
  onRequestFieldValues?: () => void
  onAddCondition: (condition: FrontmatterFilterCondition) => void
  onUpdateCondition: (index: number, nextCondition: FrontmatterFilterCondition) => void
  onRemoveCondition: (index: number) => void
  onClearConditions: () => void
  onChangeSort: (nextSort: WorkspaceSearchSortSpec) => void
}

function renderFilterNotice(
  message: string,
  actionLabel: string | undefined,
  onAction: (() => void) | undefined,
  isError = false
) {
  return (
    <div className="search-filter-bar" role="region" aria-label="프론트매터 필터 바">
      <div className={`search-filter-notice${isError ? ' is-error' : ''}`}>
        <span className="search-filter-notice-text">{message}</span>
        {actionLabel && onAction && (
          <button type="button" className="btn btn-sm" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Session-non-persistent frontmatter filter bar and sort control rendered under the Search Panel
 * text query controls.
 */
export function FrontmatterFilterBar({
  workspaceRootPath,
  schemaResult,
  fieldValuesByKey,
  conditions,
  sort,
  onCreateDefaultSchema,
  onOpenSchemaModal,
  onRequestFieldValues,
  onAddCondition,
  onUpdateCondition,
  onRemoveCondition,
  onClearConditions,
  onChangeSort
}: FrontmatterFilterBarProps) {
  const [popoverDraft, setPopoverDraft] = useState<FilterPopoverDraft | null>(null)
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null)
  const returnFocusElRef = useRef<HTMLButtonElement | null>(null)
  const sourceConditionRef = useRef<FrontmatterFilterCondition | null>(null)

  const dismissPopover = useCallback((restoreFocus: boolean): void => {
    sourceConditionRef.current = null
    setPopoverDraft(null)
    if (restoreFocus) {
      returnFocusElRef.current?.focus()
    }
  }, [])

  const handleDismiss = useCallback(
    (reason?: DismissReason): void => {
      dismissPopover(reason === 'escape')
    },
    [dismissPopover]
  )

  useDismissable(popoverDraft !== null, popoverAnchorRef, handleDismiss)

  useEffect(() => {
    dismissPopover(false)
  }, [dismissPopover, workspaceRootPath])

  const schema: WorkspaceFrontmatterSchema | null = schemaResult?.schema ?? null
  const fieldsByKey = useMemo(
    () => new Map((schema?.fields ?? []).map((field) => [field.key, field])),
    [schema]
  )

  useEffect(() => {
    if (!popoverDraft) return
    if (!schema || schema.fields.length === 0) {
      dismissPopover(false)
      return
    }
    if (popoverDraft.fieldKey) {
      const targetField = fieldsByKey.get(popoverDraft.fieldKey)
      if (
        !targetField ||
        (popoverDraft.fieldType !== null && targetField.type !== popoverDraft.fieldType) ||
        (popoverDraft.operator !== null &&
          !isFrontmatterOperatorForType(targetField.type, popoverDraft.operator))
      ) {
        dismissPopover(false)
        return
      }
    }
    if (
      popoverDraft.mode === 'edit' &&
      (popoverDraft.editIndex === null ||
        popoverDraft.editIndex >= conditions.length ||
        conditions[popoverDraft.editIndex] !== sourceConditionRef.current)
    ) {
      dismissPopover(false)
    }
  }, [conditions, dismissPopover, fieldsByKey, popoverDraft, schema])

  if (!workspaceRootPath || !schemaResult) {
    return null
  }

  if (!schemaResult.exists) {
    return renderFilterNotice('프론트매터 스키마 없음', '스키마 생성', onCreateDefaultSchema)
  }

  if (schemaResult.error) {
    return renderFilterNotice('스키마 오류', '스키마 관리', onOpenSchemaModal, true)
  }

  if (!schema || schema.fields.length === 0) {
    return renderFilterNotice('정의된 스키마 필드가 없습니다.', '스키마 관리', onOpenSchemaModal)
  }

  const selectedField =
    popoverDraft?.fieldKey ? fieldsByKey.get(popoverDraft.fieldKey) ?? null : null
  const isDraftIncompatibleWithField =
    popoverDraft !== null &&
    selectedField !== null &&
    ((popoverDraft.fieldType !== null && selectedField.type !== popoverDraft.fieldType) ||
      (popoverDraft.operator !== null &&
        !isFrontmatterOperatorForType(selectedField.type, popoverDraft.operator)))
  const showPopover =
    popoverDraft !== null &&
    (popoverDraft.step === 'field' || (selectedField !== null && !isDraftIncompatibleWithField))

  const openAddPopover = (triggerEl: HTMLButtonElement): void => {
    returnFocusElRef.current = triggerEl
    sourceConditionRef.current = null
    onRequestFieldValues?.()
    setPopoverDraft((prev) => (prev?.mode === 'add' ? null : createInitialFilterAddDraft()))
  }

  const openEditPopover = (index: number, triggerEl: HTMLButtonElement): void => {
    const condition = conditions[index]
    if (!condition) return
    const field = fieldsByKey.get(condition.fieldKey)
    returnFocusElRef.current = triggerEl
    sourceConditionRef.current = condition
    onRequestFieldValues?.()
    setPopoverDraft(createFilterEditDraft(condition, index, field?.type ?? null))
  }

  const commitPopoverCondition = (condition: FrontmatterFilterCondition): void => {
    if (popoverDraft?.mode === 'edit' && popoverDraft.editIndex !== null) {
      onUpdateCondition(popoverDraft.editIndex, condition)
    } else {
      onAddCondition(condition)
    }
    dismissPopover(false)
  }

  const handleRemoveCondition = (index: number): void => {
    dismissPopover(false)
    onRemoveCondition(index)
  }

  const handleClearConditions = (): void => {
    dismissPopover(false)
    onClearConditions()
  }

  const handleSelectField = (field: FrontmatterFieldDefinition): void => {
    if (field.type === 'multi-select' && field.allowCustom) {
      onRequestFieldValues?.()
    }
    setPopoverDraft((prev) => (prev ? createFilterFieldDraft(field) : null))
  }

  const handleSelectOperator = (
    field: FrontmatterFieldDefinition,
    operator: FrontmatterFilterOperator
  ): void => {
    if (operator === 'is-empty') {
      commitPopoverCondition({ fieldKey: field.key, operator: 'is-empty' })
      return
    }
    setPopoverDraft((prev) =>
      prev ? { ...prev, step: 'value', fieldKey: field.key, operator } : null
    )
  }

  return (
    <div
      ref={popoverAnchorRef}
      className="search-filter-bar"
      role="region"
      aria-label="프론트매터 필터 바"
    >
      <div className="search-filter-toolbar">
        <button
          type="button"
          className="search-filter-add-btn"
          aria-haspopup="dialog"
          aria-expanded={showPopover && popoverDraft.mode === 'add'}
          onClick={(event) => openAddPopover(event.currentTarget)}
        >
          + 필터 추가
        </button>

        <select
          className="search-sort-select"
          aria-label="검색 결과 정렬"
          value={serializeSearchSortSpec(sort)}
          onChange={(event) => onChangeSort(parseSearchSortValue(event.target.value))}
        >
          <option value="path:asc">기본 경로순</option>
          {schema.fields.map((field) => (
            <optgroup key={field.key} label={field.label}>
              <option
                value={serializeSearchSortSpec({
                  by: 'frontmatter',
                  fieldKey: field.key,
                  direction: 'asc'
                })}
              >
                {field.label} 오름차순
              </option>
              <option
                value={serializeSearchSortSpec({
                  by: 'frontmatter',
                  fieldKey: field.key,
                  direction: 'desc'
                })}
              >
                {field.label} 내림차순
              </option>
            </optgroup>
          ))}
        </select>

        {conditions.length > 0 && (
          <button
            type="button"
            className="search-filter-clear-btn"
            aria-label="필터 전체 초기화"
            onClick={handleClearConditions}
          >
            전체 초기화
          </button>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="search-filter-chips" role="list" aria-label="활성 프론트매터 필터">
          {conditions.map((condition, index) => {
            const field = fieldsByKey.get(condition.fieldKey)
            if (!field) return null
            const chipLabel = formatFilterChipLabel(condition, field)
            return (
              <div
                key={`${condition.fieldKey}-${condition.operator}-${index}`}
                role="listitem"
                className="search-filter-chip"
              >
                <button
                  type="button"
                  className="search-filter-chip-btn"
                  aria-label={`${field.label} 필터 수정 (${chipLabel})`}
                  title={`${chipLabel} (클릭하여 수정)`}
                  onClick={(event) => openEditPopover(index, event.currentTarget)}
                >
                  <span className="search-filter-chip-text">{chipLabel}</span>
                </button>
                <button
                  type="button"
                  className="search-filter-chip-remove"
                  aria-label={`${field.label} 필터 제거`}
                  title="필터 제거"
                  onClick={() => handleRemoveCondition(index)}
                >
                  <X size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {showPopover && (
        <FrontmatterFilterPopover
          fields={schema.fields}
          draft={popoverDraft}
          selectedField={selectedField}
          fieldValuesByKey={fieldValuesByKey}
          onSelectField={handleSelectField}
          onSelectOperator={handleSelectOperator}
          onBackToField={() =>
            setPopoverDraft((prev) => (prev ? createInitialFilterAddDraft() : null))
          }
          onBackToOperators={() =>
            setPopoverDraft((prev) => (prev ? { ...prev, step: 'operator' } : null))
          }
          onChangeDraft={(updater) => setPopoverDraft((prev) => (prev ? updater(prev) : null))}
          onCommitCondition={commitPopoverCondition}
        />
      )}
    </div>
  )
}
