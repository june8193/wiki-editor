import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  FRONTMATTER_OPERATORS_BY_TYPE,
  type FrontmatterFieldDefinition,
  type FrontmatterFilterCondition,
  type FrontmatterFilterOperator
} from '@shared/frontmatter'
import {
  buildConditionFromDraft,
  buildFilterSelectableOptions,
  cycleListboxIndex,
  type FilterPopoverDraft,
  getFrontmatterOperatorLabel
} from '../utils/frontmatterFilterBar'

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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setHighlightedIndex((prev) => cycleListboxIndex(prev, filteredFields.length, delta))
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

interface KeyboardChoiceOption<T> {
  key: string
  label: string
  value: T
}

interface KeyboardChoiceListboxProps<T> {
  options: readonly KeyboardChoiceOption<T>[]
  initialIndex: number
  ariaLabel: string
  onSelect: (value: T) => void
  onBack?: () => void
}

function KeyboardChoiceListbox<T>({
  options,
  initialIndex,
  ariaLabel,
  onSelect,
  onBack
}: KeyboardChoiceListboxProps<T>) {
  const [highlightedIndex, setHighlightedIndex] = useState(() =>
    options.length === 0 ? 0 : Math.max(0, Math.min(initialIndex, options.length - 1))
  )
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const clampedIndex =
    options.length === 0 ? -1 : Math.min(highlightedIndex, options.length - 1)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setHighlightedIndex((prev) => cycleListboxIndex(prev, options.length, delta))
      return
    }
    if (event.key === 'Enter' && clampedIndex >= 0) {
      event.preventDefault()
      onSelect(options[clampedIndex].value)
      return
    }
    if (event.key === 'Backspace' && onBack) {
      event.preventDefault()
      onBack()
    }
  }

  return (
    <div
      ref={listRef}
      tabIndex={0}
      className="search-filter-popover-list"
      role="listbox"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const isHighlighted = index === clampedIndex
        return (
          <button
            key={option.key}
            type="button"
            role="option"
            aria-selected={isHighlighted}
            className={`search-filter-popover-item${isHighlighted ? ' is-highlighted' : ''}`}
            onMouseEnter={() => setHighlightedIndex(index)}
            onClick={() => onSelect(option.value)}
          >
            <span>{option.label}</span>
          </button>
        )
      })}
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
  const initialIndex = initialOperator ? Math.max(0, operators.indexOf(initialOperator)) : 0
  const options = useMemo(
    () =>
      operators.map((op) => ({
        key: op,
        label: getFrontmatterOperatorLabel(field.type, op),
        value: op
      })),
    [field.type, operators]
  )

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

      <KeyboardChoiceListbox
        options={options}
        initialIndex={initialIndex}
        ariaLabel="필터 연산자 목록"
        onSelect={onSelectOperator}
        onBack={canGoBack ? onBack : undefined}
      />
    </div>
  )
}

const ORDERED_RANGE_INPUT_CONFIG = {
  number: {
    inputType: 'number',
    step: 'any',
    minAriaLabel: '최솟값',
    minPlaceholder: '최솟값',
    maxAriaLabel: '최댓값',
    maxPlaceholder: '최댓값',
    singleAriaLabel: '숫자 값 입력',
    singleDefaultPlaceholder: '숫자 입력'
  },
  date: {
    inputType: 'date',
    step: undefined,
    minAriaLabel: '시작일',
    minPlaceholder: undefined,
    maxAriaLabel: '종료일',
    maxPlaceholder: undefined,
    singleAriaLabel: '날짜 값 입력',
    singleDefaultPlaceholder: undefined
  }
} as const

interface OrderedRangeValueInputsProps {
  fieldType: 'number' | 'date'
  operator: FrontmatterFilterOperator
  draft: FilterPopoverDraft
  placeholder?: string
  scalarInputRef: RefObject<HTMLInputElement | null>
  onChangeDraft: (updater: (prev: FilterPopoverDraft) => FilterPopoverDraft) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

function OrderedRangeValueInputs({
  fieldType,
  operator,
  draft,
  placeholder,
  scalarInputRef,
  onChangeDraft,
  onKeyDown
}: OrderedRangeValueInputsProps) {
  const cfg = ORDERED_RANGE_INPUT_CONFIG[fieldType]

  if (operator === 'between') {
    return (
      <div className="search-filter-range-inputs">
        <input
          ref={scalarInputRef}
          type={cfg.inputType}
          step={cfg.step}
          className="search-filter-popover-input"
          aria-label={cfg.minAriaLabel}
          placeholder={cfg.minPlaceholder}
          value={draft.minValue}
          onChange={(event) =>
            onChangeDraft((prev) => ({ ...prev, minValue: event.target.value }))
          }
          onKeyDown={onKeyDown}
        />
        <span className="search-filter-range-sep" aria-hidden="true">
          ~
        </span>
        <input
          type={cfg.inputType}
          step={cfg.step}
          className="search-filter-popover-input"
          aria-label={cfg.maxAriaLabel}
          placeholder={cfg.maxPlaceholder}
          value={draft.maxValue}
          onChange={(event) =>
            onChangeDraft((prev) => ({ ...prev, maxValue: event.target.value }))
          }
          onKeyDown={onKeyDown}
        />
      </div>
    )
  }

  return (
    <input
      ref={scalarInputRef}
      type={cfg.inputType}
      step={cfg.step}
      className="search-filter-popover-input"
      aria-label={cfg.singleAriaLabel}
      placeholder={placeholder ?? cfg.singleDefaultPlaceholder}
      value={draft.textValue}
      onChange={(event) =>
        onChangeDraft((prev) => ({ ...prev, textValue: event.target.value }))
      }
      onKeyDown={onKeyDown}
    />
  )
}

interface FilterPopoverValueStepProps {
  field: FrontmatterFieldDefinition
  draft: FilterPopoverDraft
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>
  onChangeDraft: (updater: (prev: FilterPopoverDraft) => FilterPopoverDraft) => void
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
    () => buildFilterSelectableOptions(field, fieldValuesByKey?.[field.key], draft.selectedValues),
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

  const builtValidation = buildConditionFromDraft(field, draft)
  const validationError = !builtValidation.ok ? builtValidation.error : undefined

  const submitDraft = (): void => {
    if (builtValidation.ok) {
      onCommitCondition(builtValidation.condition)
    }
  }

  const handleOptionSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && totalNavigableRows > 0) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setHighlightedIdx((prev) => cycleListboxIndex(prev, totalNavigableRows, delta))
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
        </>
      )}

      {field.type === 'text' && (
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
      )}

      {(field.type === 'number' || field.type === 'date') && (
        <OrderedRangeValueInputs
          fieldType={field.type}
          operator={operator}
          draft={draft}
          placeholder={field.placeholder}
          scalarInputRef={scalarInputRef}
          onChangeDraft={onChangeDraft}
          onKeyDown={handleScalarInputKeyDown}
        />
      )}

      {field.type === 'boolean' && (
        <KeyboardChoiceListbox
          options={[
            { key: 'true', label: '예', value: true },
            { key: 'false', label: '아니오', value: false }
          ]}
          initialIndex={draft.textValue === 'false' ? 1 : 0}
          ariaLabel="불리언 값 선택"
          onSelect={(value) =>
            onCommitCondition({
              fieldKey: field.key,
              operator: 'equals',
              value
            })
          }
        />
      )}

      {validationError && <p className="search-filter-popover-error">{validationError}</p>}

      {field.type !== 'boolean' && (
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
      )}
    </div>
  )
}

export interface FrontmatterFilterPopoverProps {
  fields: readonly FrontmatterFieldDefinition[]
  draft: FilterPopoverDraft
  selectedField: FrontmatterFieldDefinition | null
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>
  onSelectField: (field: FrontmatterFieldDefinition) => void
  onSelectOperator: (field: FrontmatterFieldDefinition, operator: FrontmatterFilterOperator) => void
  onBackToField: () => void
  onBackToOperators: () => void
  onChangeDraft: (updater: (prev: FilterPopoverDraft) => FilterPopoverDraft) => void
  onCommitCondition: (condition: FrontmatterFilterCondition) => void
}

/**
 * Multi-step popover (`field -> operator -> value`) used by `FrontmatterFilterBar` to add or edit
 * frontmatter filter conditions.
 */
export function FrontmatterFilterPopover({
  fields,
  draft,
  selectedField,
  fieldValuesByKey,
  onSelectField,
  onSelectOperator,
  onBackToField,
  onBackToOperators,
  onChangeDraft,
  onCommitCondition
}: FrontmatterFilterPopoverProps) {
  return (
    <div className="search-filter-popover" role="dialog" aria-label="프론트매터 필터 설정">
      {draft.step === 'field' && (
        <FilterPopoverFieldStep fields={fields} onSelectField={onSelectField} />
      )}

      {draft.step === 'operator' && selectedField && (
        <FilterPopoverOperatorStep
          key={`${draft.mode}-${draft.editIndex ?? 'new'}-${selectedField.key}`}
          field={selectedField}
          initialOperator={draft.operator}
          canGoBack={draft.mode === 'add'}
          onBack={onBackToField}
          onSelectOperator={(operator) => onSelectOperator(selectedField, operator)}
        />
      )}

      {draft.step === 'value' && selectedField && (
        <FilterPopoverValueStep
          key={`${draft.mode}-${draft.editIndex ?? 'new'}-${selectedField.key}-${draft.operator ?? ''}`}
          field={selectedField}
          draft={draft}
          fieldValuesByKey={fieldValuesByKey}
          onChangeDraft={onChangeDraft}
          onChangeOperator={(nextOp) => onSelectOperator(selectedField, nextOp)}
          onBackToOperators={onBackToOperators}
          onCommitCondition={onCommitCondition}
        />
      )}
    </div>
  )
}
