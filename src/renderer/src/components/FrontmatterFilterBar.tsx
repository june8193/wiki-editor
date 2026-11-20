import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { ArrowLeft, X } from 'lucide-react'
import {
  FRONTMATTER_OPERATORS_BY_TYPE,
  isValidIsoCalendarDate,
  type FrontmatterFieldDefinition,
  type FrontmatterFilterCondition,
  type FrontmatterFilterOperator,
  type FrontmatterSchemaLoadResult,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import type { WorkspaceSearchSortSpec } from '@shared/search'
import { type DismissReason, useDismissable } from '../hooks/useDismissable'
import {
  buildFilterSelectableOptions,
  formatFilterChipLabel,
  getFrontmatterOperatorLabel,
  parseSearchSortValue,
  serializeSearchSortSpec
} from '../utils/frontmatterFilterBar'

type PopoverStep = 'field' | 'operator' | 'value'

interface PopoverDraft {
  mode: 'add' | 'edit'
  editIndex: number | null
  step: PopoverStep
  fieldKey: string | null
  operator: FrontmatterFilterOperator | null
  selectedValues: string[]
  textValue: string
  minValue: string
  maxValue: string
}

function createInitialAddDraft(): PopoverDraft {
  return {
    mode: 'add',
    editIndex: null,
    step: 'field',
    fieldKey: null,
    operator: null,
    selectedValues: [],
    textValue: '',
    minValue: '',
    maxValue: ''
  }
}

function createDraftForOperator(
  base: Pick<PopoverDraft, 'mode' | 'editIndex' | 'fieldKey'>,
  operator: FrontmatterFilterOperator,
  existing?: FrontmatterFilterCondition
): PopoverDraft {
  return {
    mode: base.mode,
    editIndex: base.editIndex,
    step: 'value',
    fieldKey: base.fieldKey,
    operator,
    selectedValues: existing?.values ? [...existing.values] : [],
    textValue:
      existing?.value !== undefined && existing.value !== null ? String(existing.value) : '',
    minValue: existing?.min !== undefined ? String(existing.min) : '',
    maxValue: existing?.max !== undefined ? String(existing.max) : ''
  }
}

function createEditDraft(
  condition: FrontmatterFilterCondition,
  index: number
): PopoverDraft {
  if (condition.operator === 'is-empty') {
    return {
      mode: 'edit',
      editIndex: index,
      step: 'operator',
      fieldKey: condition.fieldKey,
      operator: condition.operator,
      selectedValues: [],
      textValue: '',
      minValue: '',
      maxValue: ''
    }
  }
  return createDraftForOperator(
    { mode: 'edit', editIndex: index, fieldKey: condition.fieldKey },
    condition.operator,
    condition
  )
}

function buildConditionFromDraft(
  field: FrontmatterFieldDefinition,
  draft: PopoverDraft
): { ok: true; condition: FrontmatterFilterCondition } | { ok: false; error?: string } {
  const operator = draft.operator
  if (!operator) return { ok: false }
  if (operator === 'is-empty') {
    return { ok: true, condition: { fieldKey: field.key, operator } }
  }

  switch (field.type) {
    case 'select':
    case 'multi-select':
      if (draft.selectedValues.length === 0) {
        return { ok: false }
      }
      return {
        ok: true,
        condition: {
          fieldKey: field.key,
          operator,
          values: [...draft.selectedValues]
        }
      }

    case 'text': {
      const trimmed = draft.textValue.trim()
      if (!trimmed) return { ok: false }
      return {
        ok: true,
        condition: {
          fieldKey: field.key,
          operator,
          value: trimmed
        }
      }
    }

    case 'number': {
      if (operator === 'between') {
        if (draft.minValue.trim() === '' || draft.maxValue.trim() === '') {
          return { ok: false }
        }
        const minNum = Number(draft.minValue)
        const maxNum = Number(draft.maxValue)
        if (!Number.isFinite(minNum) || !Number.isFinite(maxNum)) {
          return { ok: false, error: '유효한 숫자를 입력하세요.' }
        }
        if (minNum > maxNum) {
          return { ok: false, error: '최솟값은 최댓값보다 클 수 없습니다.' }
        }
        return {
          ok: true,
          condition: { fieldKey: field.key, operator, min: minNum, max: maxNum }
        }
      }
      if (draft.textValue.trim() === '') return { ok: false }
      const numVal = Number(draft.textValue)
      if (!Number.isFinite(numVal)) {
        return { ok: false, error: '유효한 숫자를 입력하세요.' }
      }
      return {
        ok: true,
        condition: { fieldKey: field.key, operator, value: numVal }
      }
    }

    case 'date': {
      if (operator === 'between') {
        if (!draft.minValue || !draft.maxValue) return { ok: false }
        if (!isValidIsoCalendarDate(draft.minValue) || !isValidIsoCalendarDate(draft.maxValue)) {
          return { ok: false, error: '유효한 YYYY-MM-DD 날짜를 입력하세요.' }
        }
        if (draft.minValue > draft.maxValue) {
          return { ok: false, error: '시작일은 종료일보다 늦을 수 없습니다.' }
        }
        return {
          ok: true,
          condition: {
            fieldKey: field.key,
            operator,
            min: draft.minValue,
            max: draft.maxValue
          }
        }
      }
      if (!draft.textValue) return { ok: false }
      if (!isValidIsoCalendarDate(draft.textValue)) {
        return { ok: false, error: '유효한 YYYY-MM-DD 날짜를 입력하세요.' }
      }
      return {
        ok: true,
        condition: { fieldKey: field.key, operator, value: draft.textValue }
      }
    }

    case 'boolean':
      return { ok: false }
  }
}

interface FilterPopoverFieldStepProps {
  fields: readonly FrontmatterFieldDefinition[]
  onSelectField: (field: FrontmatterFieldDefinition) => void
}

function FilterPopoverFieldStep({ fields, onSelectField }: FilterPopoverFieldStepProps) {
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filteredFields = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return fields
    return fields.filter(
      (field) =>
        field.label.toLowerCase().includes(normalized) ||
        field.key.toLowerCase().includes(normalized)
    )
  }, [fields, query])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [query])

  const clampedIndex =
    filteredFields.length === 0 ? -1 : Math.min(highlightedIndex, filteredFields.length - 1)

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (filteredFields.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((prev) => (prev + 1) % filteredFields.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((prev) => (prev - 1 + filteredFields.length) % filteredFields.length)
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && clampedIndex >= 0) {
      event.preventDefault()
      onSelectField(filteredFields[clampedIndex])
    }
  }

  return (
    <div className="search-filter-popover-step">
      <input
        ref={inputRef}
        type="text"
        className="search-filter-popover-input"
        aria-label="필터 필드 검색"
        placeholder="필드 검색..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {filteredFields.length === 0 ? (
        <p className="search-filter-popover-empty">일치하는 필드가 없습니다.</p>
      ) : (
        <div className="search-filter-popover-list" role="listbox" aria-label="필터 필드 목록">
          {filteredFields.map((field, index) => {
            const isHighlighted = index === clampedIndex
            return (
              <button
                key={field.key}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                className={`search-filter-popover-item${isHighlighted ? ' is-highlighted' : ''}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => onSelectField(field)}
              >
                <span className="search-filter-popover-item-label">{field.label}</span>
                <span className="search-filter-popover-item-key">{field.key}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface FilterPopoverOperatorStepProps {
  field: FrontmatterFieldDefinition
  initialOperator: FrontmatterFilterOperator | null
  canGoBack: boolean
  onBack: () => void
  onSelectOperator: (operator: FrontmatterFilterOperator) => void
}

function FilterPopoverOperatorStep({
  field,
  initialOperator,
  canGoBack,
  onBack,
  onSelectOperator
}: FilterPopoverOperatorStepProps) {
  const operators = FRONTMATTER_OPERATORS_BY_TYPE[field.type]
  const [highlightedIndex, setHighlightedIndex] = useState(() => {
    if (!initialOperator) return 0
    const idx = operators.indexOf(initialOperator)
    return idx >= 0 ? idx : 0
  })
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((prev) => (prev + 1) % operators.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((prev) => (prev - 1 + operators.length) % operators.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      onSelectOperator(operators[highlightedIndex])
      return
    }
    if (event.key === 'Backspace' && canGoBack) {
      event.preventDefault()
      onBack()
    }
  }

  return (
    <div className="search-filter-popover-step">
      <div className="search-filter-popover-header">
        {canGoBack && (
          <button
            type="button"
            className="icon-btn search-filter-back-btn"
            aria-label="필드 선택으로 돌아가기"
            onClick={onBack}
          >
            <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        <span className="search-filter-popover-title">{field.label} · 조건 선택</span>
      </div>

      <div
        ref={listRef}
        tabIndex={0}
        className="search-filter-popover-list"
        role="listbox"
        aria-label="필터 연산자 목록"
        onKeyDown={handleKeyDown}
      >
        {operators.map((op, index) => {
          const isHighlighted = index === highlightedIndex
          return (
            <button
              key={op}
              type="button"
              role="option"
              aria-selected={isHighlighted}
              className={`search-filter-popover-item${isHighlighted ? ' is-highlighted' : ''}`}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => onSelectOperator(op)}
            >
              <span>{getFrontmatterOperatorLabel(field.type, op)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface BooleanFilterChoiceListProps {
  initialValue: boolean
  onSelect: (value: boolean) => void
}

function BooleanFilterChoiceList({ initialValue, onSelect }: BooleanFilterChoiceListProps) {
  const [highlightedIdx, setHighlightedIdx] = useState(initialValue ? 0 : 1)
  const listRef = useRef<HTMLDivElement | null>(null)
  const choices = [
    { label: '예', value: true },
    { label: '아니오', value: false }
  ] as const

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  return (
    <div
      ref={listRef}
      tabIndex={0}
      className="search-filter-popover-list"
      role="listbox"
      aria-label="불리언 값 선택"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setHighlightedIdx((prev) => (prev === 0 ? 1 : 0))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          onSelect(choices[highlightedIdx].value)
        }
      }}
    >
      {choices.map((choice, index) => (
        <button
          key={choice.label}
          type="button"
          role="option"
          aria-selected={index === highlightedIdx}
          className={`search-filter-popover-item${index === highlightedIdx ? ' is-highlighted' : ''}`}
          onMouseEnter={() => setHighlightedIdx(index)}
          onClick={() => onSelect(choice.value)}
        >
          <span>{choice.label}</span>
        </button>
      ))}
    </div>
  )
}

interface FilterPopoverValueStepProps {
  field: FrontmatterFieldDefinition
  draft: PopoverDraft
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>
  onChangeDraft: (updater: (prev: PopoverDraft) => PopoverDraft) => void
  onChangeOperator: (nextOp: FrontmatterFilterOperator) => void
  onBackToOperators: () => void
  onCommitCondition: (condition: FrontmatterFilterCondition) => void
}

function FilterPopoverValueStep({
  field,
  draft,
  fieldValuesByKey,
  onChangeDraft,
  onChangeOperator,
  onBackToOperators,
  onCommitCondition
}: FilterPopoverValueStepProps) {
  const [optionQuery, setOptionQuery] = useState('')
  const [highlightedIdx, setHighlightedIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const scalarInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (field.type === 'select' || field.type === 'multi-select') {
      searchInputRef.current?.focus()
    } else if (field.type !== 'boolean') {
      scalarInputRef.current?.focus()
    }
  }, [field.type, draft.operator])

  const operators = FRONTMATTER_OPERATORS_BY_TYPE[field.type]
  const operator = draft.operator ?? operators[0]

  const allOptions = useMemo(
    () => buildFilterSelectableOptions(field, fieldValuesByKey, draft.selectedValues),
    [draft.selectedValues, field, fieldValuesByKey]
  )

  const trimmedQuery = optionQuery.trim()
  const filteredOptions = useMemo(() => {
    const normalized = trimmedQuery.toLowerCase()
    if (!normalized) return allOptions
    return allOptions.filter((opt) => opt.value.toLowerCase().includes(normalized))
  }, [allOptions, trimmedQuery])

  const canAddCustomOption =
    field.type === 'multi-select' &&
    Boolean(field.allowCustom) &&
    trimmedQuery.length > 0 &&
    !allOptions.some((opt) => opt.value === trimmedQuery)

  const totalNavigableRows = filteredOptions.length + (canAddCustomOption ? 1 : 0)
  const clampedIdx = totalNavigableRows === 0 ? -1 : Math.min(highlightedIdx, totalNavigableRows - 1)

  useEffect(() => {
    setHighlightedIdx(0)
  }, [optionQuery])

  const toggleOptionValue = (val: string): void => {
    onChangeDraft((prev) => {
      const exists = prev.selectedValues.includes(val)
      return {
        ...prev,
        selectedValues: exists
          ? prev.selectedValues.filter((item) => item !== val)
          : [...prev.selectedValues, val]
      }
    })
  }

  const addCustomOptionValue = (val: string): void => {
    const trimmed = val.trim()
    if (!trimmed) return
    onChangeDraft((prev) => ({
      ...prev,
      selectedValues: prev.selectedValues.includes(trimmed)
        ? prev.selectedValues
        : [...prev.selectedValues, trimmed]
    }))
    setOptionQuery('')
  }

  const submitDraft = (): void => {
    const built = buildConditionFromDraft(field, draft)
    if (built.ok) {
      onCommitCondition(built.condition)
    }
  }

  const builtValidation = buildConditionFromDraft(field, draft)
  const validationError = !builtValidation.ok ? builtValidation.error : undefined

  const handleOptionSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && totalNavigableRows > 0) {
      event.preventDefault()
      setHighlightedIdx((prev) => (prev + 1) % totalNavigableRows)
      return
    }
    if (event.key === 'ArrowUp' && totalNavigableRows > 0) {
      event.preventDefault()
      setHighlightedIdx((prev) => (prev - 1 + totalNavigableRows) % totalNavigableRows)
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (trimmedQuery.length > 0) {
        if (clampedIdx >= 0 && clampedIdx < filteredOptions.length) {
          toggleOptionValue(filteredOptions[clampedIdx].value)
          setOptionQuery('')
          return
        }
        if (canAddCustomOption) {
          addCustomOptionValue(trimmedQuery)
        }
        return
      }
      submitDraft()
    }
  }

  const handleScalarInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submitDraft()
    }
  }

  return (
    <div className="search-filter-popover-step">
      <div className="search-filter-popover-header">
        {draft.mode === 'add' && (
          <button
            type="button"
            className="icon-btn search-filter-back-btn"
            aria-label="연산자 선택으로 돌아가기"
            onClick={onBackToOperators}
          >
            <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        <span className="search-filter-popover-title">{field.label}</span>
        <select
          className="search-filter-op-select"
          aria-label="연산자 선택"
          value={operator}
          onChange={(event) =>
            onChangeOperator(event.target.value as FrontmatterFilterOperator)
          }
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {getFrontmatterOperatorLabel(field.type, op)}
            </option>
          ))}
        </select>
      </div>

      {(field.type === 'select' || field.type === 'multi-select') && (
        <>
          <input
            ref={searchInputRef}
            type="text"
            className="search-filter-popover-input"
            aria-label="옵션 값 검색"
            placeholder={
              field.type === 'multi-select' && field.allowCustom
                ? '값 검색 또는 직접 입력...'
                : '값 검색...'
            }
            value={optionQuery}
            onChange={(event) => setOptionQuery(event.target.value)}
            onKeyDown={handleOptionSearchKeyDown}
          />
          <div className="search-filter-popover-list" role="group" aria-label={`${field.label} 값 선택`}>
            {filteredOptions.map((opt, index) => {
              const checked = draft.selectedValues.includes(opt.value)
              const isHighlighted = index === clampedIdx
              return (
                <label
                  key={opt.value}
                  className={`search-filter-option-row${isHighlighted ? ' is-highlighted' : ''}`}
                  onMouseEnter={() => setHighlightedIdx(index)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOptionValue(opt.value)}
                  />
                  {opt.color && (
                    <span
                      className="properties-color-dot"
                      style={{ backgroundColor: opt.color }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="search-filter-option-text">{opt.value}</span>
                </label>
              )
            })}
            {canAddCustomOption && (
              <button
                type="button"
                className={`search-filter-popover-item${
                  clampedIdx === filteredOptions.length ? ' is-highlighted' : ''
                }`}
                onClick={() => addCustomOptionValue(trimmedQuery)}
              >
                + &quot;{trimmedQuery}&quot; 추가
              </button>
            )}
            {totalNavigableRows === 0 && (
              <p className="search-filter-popover-empty">선택 가능한 값이 없습니다.</p>
            )}
          </div>
          <div className="search-filter-popover-footer">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!builtValidation.ok}
              onClick={submitDraft}
            >
              적용
            </button>
          </div>
        </>
      )}

      {field.type === 'text' && (
        <>
          <input
            ref={scalarInputRef}
            type="text"
            className="search-filter-popover-input"
            aria-label="필터 값 입력"
            placeholder={field.placeholder ?? '텍스트 입력'}
            value={draft.textValue}
            onChange={(event) =>
              onChangeDraft((prev) => ({ ...prev, textValue: event.target.value }))
            }
            onKeyDown={handleScalarInputKeyDown}
          />
          <div className="search-filter-popover-footer">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!builtValidation.ok}
              onClick={submitDraft}
            >
              적용
            </button>
          </div>
        </>
      )}

      {field.type === 'number' && (
        <>
          {operator === 'between' ? (
            <div className="search-filter-range-inputs">
              <input
                ref={scalarInputRef}
                type="number"
                step="any"
                className="search-filter-popover-input"
                aria-label="최솟값"
                placeholder="최솟값"
                value={draft.minValue}
                onChange={(event) =>
                  onChangeDraft((prev) => ({ ...prev, minValue: event.target.value }))
                }
                onKeyDown={handleScalarInputKeyDown}
              />
              <span className="search-filter-range-sep" aria-hidden="true">
                ~
              </span>
              <input
                type="number"
                step="any"
                className="search-filter-popover-input"
                aria-label="최댓값"
                placeholder="최댓값"
                value={draft.maxValue}
                onChange={(event) =>
                  onChangeDraft((prev) => ({ ...prev, maxValue: event.target.value }))
                }
                onKeyDown={handleScalarInputKeyDown}
              />
            </div>
          ) : (
            <input
              ref={scalarInputRef}
              type="number"
              step="any"
              className="search-filter-popover-input"
              aria-label="숫자 값 입력"
              placeholder={field.placeholder ?? '숫자 입력'}
              value={draft.textValue}
              onChange={(event) =>
                onChangeDraft((prev) => ({ ...prev, textValue: event.target.value }))
              }
              onKeyDown={handleScalarInputKeyDown}
            />
          )}
          {validationError && <p className="search-filter-popover-error">{validationError}</p>}
          <div className="search-filter-popover-footer">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!builtValidation.ok}
              onClick={submitDraft}
            >
              적용
            </button>
          </div>
        </>
      )}

      {field.type === 'date' && (
        <>
          {operator === 'between' ? (
            <div className="search-filter-range-inputs">
              <input
                ref={scalarInputRef}
                type="date"
                className="search-filter-popover-input"
                aria-label="시작일"
                value={draft.minValue}
                onChange={(event) =>
                  onChangeDraft((prev) => ({ ...prev, minValue: event.target.value }))
                }
                onKeyDown={handleScalarInputKeyDown}
              />
              <span className="search-filter-range-sep" aria-hidden="true">
                ~
              </span>
              <input
                type="date"
                className="search-filter-popover-input"
                aria-label="종료일"
                value={draft.maxValue}
                onChange={(event) =>
                  onChangeDraft((prev) => ({ ...prev, maxValue: event.target.value }))
                }
                onKeyDown={handleScalarInputKeyDown}
              />
            </div>
          ) : (
            <input
              ref={scalarInputRef}
              type="date"
              className="search-filter-popover-input"
              aria-label="날짜 값 입력"
              value={draft.textValue}
              onChange={(event) =>
                onChangeDraft((prev) => ({ ...prev, textValue: event.target.value }))
              }
              onKeyDown={handleScalarInputKeyDown}
            />
          )}
          {validationError && <p className="search-filter-popover-error">{validationError}</p>}
          <div className="search-filter-popover-footer">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!builtValidation.ok}
              onClick={submitDraft}
            >
              적용
            </button>
          </div>
        </>
      )}

      {field.type === 'boolean' && (
        <BooleanFilterChoiceList
          initialValue={draft.textValue === 'false' ? false : true}
          onSelect={(value) =>
            onCommitCondition({
              fieldKey: field.key,
              operator: 'equals',
              value
            })
          }
        />
      )}
    </div>
  )
}

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
  const [popoverDraft, setPopoverDraft] = useState<PopoverDraft | null>(null)
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null)
  const returnFocusElRef = useRef<HTMLButtonElement | null>(null)

  const closePopover = useCallback((reason?: DismissReason): void => {
    setPopoverDraft(null)
    if (reason === 'escape') {
      returnFocusElRef.current?.focus()
    }
  }, [])

  useDismissable(popoverDraft !== null, popoverAnchorRef, closePopover)

  useEffect(() => {
    setPopoverDraft(null)
  }, [workspaceRootPath])

  const schema: WorkspaceFrontmatterSchema | null = schemaResult?.schema ?? null

  useEffect(() => {
    if (!schema || schema.fields.length === 0) {
      setPopoverDraft(null)
    }
  }, [schema])

  if (!workspaceRootPath || !schemaResult) {
    return null
  }

  if (!schemaResult.exists) {
    return (
      <div className="search-filter-bar" role="region" aria-label="프론트매터 필터 바">
        <div className="search-filter-notice">
          <span className="search-filter-notice-text">프론트매터 스키마 없음</span>
          <button type="button" className="btn btn-sm" onClick={onCreateDefaultSchema}>
            스키마 생성
          </button>
        </div>
      </div>
    )
  }

  if (schemaResult.error) {
    return (
      <div className="search-filter-bar" role="region" aria-label="프론트매터 필터 바">
        <div className="search-filter-notice is-error">
          <span className="search-filter-notice-text">스키마 오류</span>
          {onOpenSchemaModal && (
            <button type="button" className="btn btn-sm" onClick={onOpenSchemaModal}>
              스키마 관리
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!schema || schema.fields.length === 0) {
    return (
      <div className="search-filter-bar" role="region" aria-label="프론트매터 필터 바">
        <div className="search-filter-notice">
          <span className="search-filter-notice-text">정의된 스키마 필드가 없습니다.</span>
          {onOpenSchemaModal && (
            <button type="button" className="btn btn-sm" onClick={onOpenSchemaModal}>
              스키마 관리
            </button>
          )}
        </div>
      </div>
    )
  }

  const fieldsByKey = new Map(schema.fields.map((field) => [field.key, field]))
  const selectedField =
    popoverDraft?.fieldKey ? fieldsByKey.get(popoverDraft.fieldKey) ?? null : null

  const openAddPopover = (triggerEl: HTMLButtonElement): void => {
    returnFocusElRef.current = triggerEl
    onRequestFieldValues?.()
    setPopoverDraft((prev) => (prev?.mode === 'add' ? null : createInitialAddDraft()))
  }

  const openEditPopover = (index: number, triggerEl: HTMLButtonElement): void => {
    const condition = conditions[index]
    if (!condition) return
    returnFocusElRef.current = triggerEl
    onRequestFieldValues?.()
    setPopoverDraft(createEditDraft(condition, index))
  }

  const commitPopoverCondition = (condition: FrontmatterFilterCondition): void => {
    if (popoverDraft?.mode === 'edit' && popoverDraft.editIndex !== null) {
      onUpdateCondition(popoverDraft.editIndex, condition)
    } else {
      onAddCondition(condition)
    }
    setPopoverDraft(null)
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
      prev
        ? {
            ...prev,
            step: 'value',
            fieldKey: field.key,
            operator
          }
        : null
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
          aria-expanded={popoverDraft?.mode === 'add'}
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
            onClick={onClearConditions}
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
                  onClick={() => onRemoveCondition(index)}
                >
                  <X size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {popoverDraft && (
        <div
          className="search-filter-popover"
          role="dialog"
          aria-label="프론트매터 필터 설정"
        >
          {popoverDraft.step === 'field' && (
            <FilterPopoverFieldStep
              fields={schema.fields}
              onSelectField={(field) => {
                if (field.type === 'multi-select' && field.allowCustom) {
                  onRequestFieldValues?.()
                }
                setPopoverDraft((prev) =>
                  prev
                    ? { ...prev, step: 'operator', fieldKey: field.key, operator: null }
                    : null
                )
              }}
            />
          )}

          {popoverDraft.step === 'operator' && selectedField && (
            <FilterPopoverOperatorStep
              field={selectedField}
              initialOperator={popoverDraft.operator}
              canGoBack={popoverDraft.mode === 'add'}
              onBack={() =>
                setPopoverDraft((prev) =>
                  prev ? { ...prev, step: 'field', fieldKey: null, operator: null } : null
                )
              }
              onSelectOperator={(op) => handleSelectOperator(selectedField, op)}
            />
          )}

          {popoverDraft.step === 'value' && selectedField && (
            <FilterPopoverValueStep
              field={selectedField}
              draft={popoverDraft}
              fieldValuesByKey={fieldValuesByKey}
              onChangeDraft={(updater) => setPopoverDraft((prev) => (prev ? updater(prev) : null))}
              onChangeOperator={(nextOp) => handleSelectOperator(selectedField, nextOp)}
              onBackToOperators={() =>
                setPopoverDraft((prev) => (prev ? { ...prev, step: 'operator' } : null))
              }
              onCommitCondition={commitPopoverCondition}
            />
          )}
        </div>
      )}
    </div>
  )
}
