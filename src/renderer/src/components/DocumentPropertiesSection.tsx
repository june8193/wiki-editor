import { memo, useId, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Settings } from 'lucide-react'
import {
  applyFrontmatterValues,
  buildSelectableFieldOptions,
  isValidIsoCalendarDate,
  parseFrontmatterDocument,
  removeFrontmatterBlock,
  type FrontmatterFieldDefinition,
  type FrontmatterFieldValue,
  type FrontmatterMutationResult,
  type FrontmatterOptionSpec,
  type FrontmatterSchemaLoadResult,
  type FrontmatterValidationIssue,
  type ParsedFrontmatterDocument
} from '@shared/frontmatter'
import type { SidebarDocumentContext } from '../editor/editorModes'
import { SidebarAccordionSection } from './SidebarAccordionSection'

export interface DocumentPropertiesSectionProps {
  document: SidebarDocumentContext
  schemaResult: FrontmatterSchemaLoadResult | null
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>
  isSchemaLoading?: boolean
  canManageSchema?: boolean
  isExpanded?: boolean
  flexRatio?: number | null
  onToggleExpanded: () => void
  onChangeContent: (nextContent: string) => void
  onCreateDefaultSchema: () => void
  onRequestFieldValues?: () => void
  onOpenSchemaModal?: () => void
  onOpenSchemaRawJson?: () => void
}

function isFieldValueFilled(value: FrontmatterFieldValue | undefined): boolean {
  if (value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length > 0
  return false
}

function findOptionColor(
  options: readonly FrontmatterOptionSpec[] | undefined,
  value: string
): string | undefined {
  return options?.find((opt) => opt.value === value)?.color
}

function OptionColorDot({ color }: { color: string | undefined }) {
  if (!color) return null
  return (
    <span
      className="properties-color-dot"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

function groupIssuesByField(issues: readonly FrontmatterValidationIssue[]): {
  documentIssues: FrontmatterValidationIssue[]
  fieldIssuesByKey: Map<string, FrontmatterValidationIssue[]>
} {
  const documentIssues: FrontmatterValidationIssue[] = []
  const fieldIssuesByKey = new Map<string, FrontmatterValidationIssue[]>()

  for (const issue of issues) {
    if (!issue.key) {
      documentIssues.push(issue)
      continue
    }
    const list = fieldIssuesByKey.get(issue.key) ?? []
    list.push(issue)
    fieldIssuesByKey.set(issue.key, list)
  }

  return { documentIssues, fieldIssuesByKey }
}

interface FieldInputProps {
  field: FrontmatterFieldDefinition
  inputId: string
  value: FrontmatterFieldValue | undefined
  suggestedValues?: readonly string[]
  onRequestFieldValues?: () => void
  onUpdateField: (key: string, nextValue: FrontmatterFieldValue | null) => void
}

function NumberPropertyInput({
  field,
  inputId,
  value,
  onUpdateField
}: FieldInputProps) {
  const canonicalText = typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  const [draftState, setDraftState] = useState<{ base: string; text: string } | null>(null)
  const displayValue =
    draftState !== null && draftState.base === canonicalText ? draftState.text : canonicalText

  return (
    <input
      id={inputId}
      type="number"
      step="any"
      className="properties-input"
      placeholder={field.placeholder}
      aria-required={field.required || undefined}
      value={displayValue}
      onChange={(event) => {
        const nextText = event.target.value
        if (nextText === '') {
          setDraftState(null)
          onUpdateField(field.key, null)
          return
        }
        const parsedNum = Number(nextText)
        if (Number.isFinite(parsedNum)) {
          setDraftState({ base: String(parsedNum), text: nextText })
          onUpdateField(field.key, parsedNum)
          return
        }
        setDraftState({ base: canonicalText, text: nextText })
      }}
      onBlur={() => setDraftState(null)}
    />
  )
}

function MultiSelectPropertyInput({
  field,
  inputId,
  value,
  suggestedValues,
  onRequestFieldValues,
  onUpdateField
}: FieldInputProps) {
  const [customDraft, setCustomDraft] = useState('')
  const selectedItems = Array.isArray(value) ? value : []
  const selectedSet = new Set(selectedItems)
  const schemaOptionValues = new Set((field.options ?? []).map((opt) => opt.value))

  const availableSuggestions = buildSelectableFieldOptions(field, suggestedValues).filter(
    (option) => !selectedSet.has(option.value)
  )

  const normalizedQuery = customDraft.trim().toLowerCase()
  const visibleSuggestions =
    field.allowCustom && normalizedQuery
      ? availableSuggestions.filter((option) => option.value.toLowerCase().includes(normalizedQuery))
      : availableSuggestions

  const addValue = (incoming: string): void => {
    const trimmed = incoming.trim()
    if (!trimmed) return
    if (!field.allowCustom && !schemaOptionValues.has(trimmed)) {
      return
    }
    if (selectedSet.has(trimmed)) {
      setCustomDraft('')
      return
    }
    onUpdateField(field.key, [...selectedItems, trimmed])
    setCustomDraft('')
  }

  const removeValue = (target: string): void => {
    const next = selectedItems.filter((item) => item !== target)
    onUpdateField(field.key, next.length > 0 ? next : null)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    addValue(customDraft)
  }

  return (
    <div className="properties-multiselect" role="group" aria-label={`${field.label} 선택`}>
      {selectedItems.length > 0 && (
        <div className="properties-chip-list">
          {selectedItems.map((item) => {
            const color = findOptionColor(field.options, item)
            const isDisallowed = !field.allowCustom && !schemaOptionValues.has(item)
            return (
              <span
                key={item}
                className={`properties-chip${isDisallowed ? ' is-invalid' : ''}`}
              >
                <OptionColorDot color={color} />
                <span className="properties-chip-label">{item}</span>
                <button
                  type="button"
                  className="properties-chip-remove"
                  aria-label={`${field.label} ${item} 제거`}
                  onClick={() => removeValue(item)}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}

      {field.allowCustom && (
        <input
          id={inputId}
          type="text"
          className="properties-input"
          placeholder={field.placeholder ?? '값 입력 후 Enter'}
          aria-required={field.required || undefined}
          value={customDraft}
          onFocus={() => onRequestFieldValues?.()}
          onChange={(event) => setCustomDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      )}

      {visibleSuggestions.length > 0 && (
        <div className="properties-suggestion-list" aria-label={`${field.label} 제안`}>
          {visibleSuggestions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="properties-suggestion-btn"
              onClick={() => addValue(option.value)}
            >
              <OptionColorDot color={option.color} />
              <span>+ {option.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PropertyFieldWidget({
  field,
  inputId,
  value,
  suggestedValues,
  onRequestFieldValues,
  onUpdateField
}: FieldInputProps) {
  switch (field.type) {
    case 'text':
      return (
        <input
          id={inputId}
          type="text"
          className="properties-input"
          placeholder={field.placeholder}
          aria-required={field.required || undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            const nextText = event.target.value
            onUpdateField(field.key, nextText === '' ? null : nextText)
          }}
        />
      )

    case 'number':
      return (
        <NumberPropertyInput
          field={field}
          inputId={inputId}
          value={value}
          onUpdateField={onUpdateField}
        />
      )

    case 'boolean': {
      const hasBooleanValue = typeof value === 'boolean'
      const stateLabel = value === true ? '예' : value === false ? '아니오' : '미지정'
      return (
        <div className="properties-boolean-row">
          <div className="properties-boolean-toggle">
            <input
              id={inputId}
              type="checkbox"
              checked={value === true}
              aria-required={field.required || undefined}
              onChange={(event) => onUpdateField(field.key, event.target.checked)}
            />
            <span className="properties-boolean-state">{stateLabel}</span>
          </div>
          {hasBooleanValue && (
            <button
              type="button"
              className="properties-clear-btn"
              aria-label={`${field.label} 값 지우기`}
              title="값 지우기"
              onClick={() => onUpdateField(field.key, null)}
            >
              ×
            </button>
          )}
        </div>
      )
    }

    case 'date': {
      const validDate = typeof value === 'string' && isValidIsoCalendarDate(value) ? value : ''
      return (
        <input
          id={inputId}
          type="date"
          className="properties-input"
          aria-required={field.required || undefined}
          value={validDate}
          onChange={(event) => {
            const nextDate = event.target.value
            onUpdateField(field.key, nextDate === '' ? null : nextDate)
          }}
        />
      )
    }

    case 'select': {
      const currentValue = typeof value === 'string' ? value : ''
      const optionList = field.options ?? []
      const hasKnownOption = optionList.some((opt) => opt.value === currentValue)
      const selectedColor = findOptionColor(optionList, currentValue)

      return (
        <div className="properties-select-wrap">
          <OptionColorDot color={selectedColor} />
          <select
            id={inputId}
            className="properties-select"
            aria-required={field.required || undefined}
            value={currentValue}
            onChange={(event) => {
              const nextValue = event.target.value
              onUpdateField(field.key, nextValue === '' ? null : nextValue)
            }}
          >
            <option value="">선택 안 함</option>
            {optionList.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value}
              </option>
            ))}
            {currentValue !== '' && !hasKnownOption && (
              <option value={currentValue}>{currentValue} (허용 외)</option>
            )}
          </select>
        </div>
      )
    }

    case 'multi-select':
      return (
        <MultiSelectPropertyInput
          field={field}
          inputId={inputId}
          value={value}
          suggestedValues={suggestedValues}
          onRequestFieldValues={onRequestFieldValues}
          onUpdateField={onUpdateField}
        />
      )
  }
}

interface UnknownEntriesCollapsibleProps {
  unknownEntries: ParsedFrontmatterDocument['unknownEntries']
}

function UnknownEntriesCollapsible({ unknownEntries }: UnknownEntriesCollapsibleProps) {
  const [isOpen, setIsOpen] = useState(false)
  if (unknownEntries.length === 0) return null

  return (
    <div className="properties-unknown-block">
      <button
        type="button"
        className="properties-unknown-toggle"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        {isOpen ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span>미정의 필드 ({unknownEntries.length}) · 보존</span>
      </button>

      {isOpen && (
        <dl className="properties-unknown-list">
          {unknownEntries.map((entry) => (
            <div key={entry.key} className="properties-unknown-row">
              <dt className="properties-unknown-key">{entry.key}</dt>
              <dd className="properties-unknown-value">{entry.rawValue || '(비어 있음)'}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

interface DocumentPropertiesFormProps {
  idPrefix: string
  parsed: ParsedFrontmatterDocument
  schemaResult: FrontmatterSchemaLoadResult | null
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>
  isSchemaLoading: boolean
  canManageSchema: boolean
  hasYamlSyntaxError: boolean
  onCreateDefaultSchema: () => void
  onRequestFieldValues?: () => void
  onOpenSchemaModal?: () => void
  onOpenSchemaRawJson?: () => void
  onAddFrontmatter: () => void
  onRemoveFrontmatter: () => void
  onUpdateField: (key: string, nextValue: FrontmatterFieldValue | null) => void
}

function DocumentPropertiesForm({
  idPrefix,
  parsed,
  schemaResult,
  fieldValuesByKey,
  isSchemaLoading,
  canManageSchema,
  hasYamlSyntaxError,
  onCreateDefaultSchema,
  onRequestFieldValues,
  onOpenSchemaModal,
  onOpenSchemaRawJson,
  onAddFrontmatter,
  onRemoveFrontmatter,
  onUpdateField
}: DocumentPropertiesFormProps) {
  const schema = schemaResult?.schema ?? null
  const { documentIssues, fieldIssuesByKey } = groupIssuesByField(parsed.issues)

  const renderManageSchemaButton = (primary: boolean) =>
    onOpenSchemaModal ? (
      <button
        type="button"
        className={`btn btn-sm${primary ? ' btn-primary' : ''}`}
        disabled={!canManageSchema}
        onClick={onOpenSchemaModal}
      >
        스키마 관리
      </button>
    ) : null

  const renderSchemaNotice = () => {
    if (isSchemaLoading && !schemaResult) {
      return <p className="properties-empty-text">스키마를 불러오는 중...</p>
    }
    if (!schemaResult || !schemaResult.exists) {
      return (
        <div className="properties-notice-card">
          <p className="properties-notice-text">
            워크스페이스 프론트매터 스키마(.wiki-editor/frontmatter.json)가 없습니다.
          </p>
          <div className="properties-notice-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onCreateDefaultSchema}
            >
              스키마 생성
            </button>
            {renderManageSchemaButton(false)}
          </div>
        </div>
      )
    }
    if (schemaResult.error) {
      return (
        <div className="properties-warning-card">
          <p className="properties-warning-title">스키마 오류</p>
          <p className="properties-warning-text">{schemaResult.error}</p>
          {(onOpenSchemaModal || onOpenSchemaRawJson) && (
            <div className="properties-notice-actions">
              {renderManageSchemaButton(true)}
              {onOpenSchemaRawJson && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!canManageSchema}
                  onClick={onOpenSchemaRawJson}
                >
                  JSON 파일로 열기
                </button>
              )}
            </div>
          )}
        </div>
      )
    }
    return null
  }

  return (
    <div className="properties-form-stack">
      {renderSchemaNotice()}

      {hasYamlSyntaxError && (
        <div className="properties-warning-card">
          <p className="properties-warning-title">YAML 구문 오류 · 미파싱 원문 보호</p>
          {documentIssues.map((issue, idx) => (
            <p key={idx} className="properties-warning-text">
              {issue.message}
            </p>
          ))}
          <p className="properties-warning-hint">
            기존 원문 보호를 위해 GUI 속성 편집이 비활성화되었습니다. Raw 모드에서 수정해 주세요.
          </p>
        </div>
      )}

      {!hasYamlSyntaxError && schema && !parsed.hasFrontmatter && (
        <div className="properties-notice-card">
          <p className="properties-notice-text">이 문서에 프론트매터가 없습니다.</p>
          <button type="button" className="btn btn-sm btn-primary" onClick={onAddFrontmatter}>
            + 속성 추가
          </button>
        </div>
      )}

      {!hasYamlSyntaxError && schema && parsed.hasFrontmatter && (
        <div className="properties-fields-list">
          {schema.fields.map((field) => {
            const inputId = `${idPrefix}-${field.key}`
            const issues = fieldIssuesByKey.get(field.key) ?? []
            const hasControl = field.type !== 'multi-select' || Boolean(field.allowCustom)

            return (
              <div
                key={field.key}
                className={`properties-field-row${issues.length > 0 ? ' has-warning' : ''}`}
              >
                <div className="properties-field-label-row">
                  <span className="properties-field-label-wrap">
                    {hasControl ? (
                      <label htmlFor={inputId} className="properties-field-label">
                        {field.label}
                      </label>
                    ) : (
                      <span className="properties-field-label">{field.label}</span>
                    )}
                    {field.required && (
                      <span className="properties-required-mark" aria-hidden="true">
                        *
                      </span>
                    )}
                  </span>
                  <span className="properties-field-key">{field.key}</span>
                </div>

                <PropertyFieldWidget
                  field={field}
                  inputId={inputId}
                  value={parsed.values[field.key]}
                  suggestedValues={fieldValuesByKey?.[field.key]}
                  onRequestFieldValues={onRequestFieldValues}
                  onUpdateField={onUpdateField}
                />

                {issues.map((issue) => (
                  <p
                    key={`${issue.code}-${issue.message}`}
                    className="properties-field-warning"
                    data-validation-code={issue.code}
                  >
                    ⚠ {issue.message}
                  </p>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {!hasYamlSyntaxError && parsed.hasFrontmatter && (
        <>
          <UnknownEntriesCollapsible unknownEntries={parsed.unknownEntries} />
          <div className="properties-footer-actions">
            <button
              type="button"
              className="btn btn-sm properties-remove-btn"
              onClick={onRemoveFrontmatter}
            >
              프론트매터 제거
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Right sidebar accordion section for viewing, validating, and editing document YAML frontmatter
 * against the workspace schema.
 */
export const DocumentPropertiesSection = memo(function DocumentPropertiesSection({
  document,
  schemaResult,
  fieldValuesByKey,
  isSchemaLoading = false,
  canManageSchema = true,
  isExpanded = true,
  flexRatio = null,
  onToggleExpanded,
  onChangeContent,
  onCreateDefaultSchema,
  onRequestFieldValues,
  onOpenSchemaModal,
  onOpenSchemaRawJson
}: DocumentPropertiesSectionProps) {
  const { documentName, documentKey, content, isMarkdownDocument } = document
  const idPrefix = useId()
  const hasActiveDocument = documentName !== null
  const isEditableMarkdown = Boolean(hasActiveDocument && isMarkdownDocument)

  const schema = schemaResult?.schema ?? null
  const parsed = isEditableMarkdown ? parseFrontmatterDocument(content, schema) : null
  const hasYamlSyntaxError = Boolean(
    parsed?.issues.some((issue) => issue.code === 'yaml-syntax-error')
  )

  const totalCount = schema ? schema.fields.length : 0
  const filledCount =
    schema && parsed
      ? schema.fields.reduce(
          (count, field) => (isFieldValueFilled(parsed.values[field.key]) ? count + 1 : count),
          0
        )
      : 0
  const issueCount = parsed ? parsed.issues.length : 0

  const applyMutation = (mutate: () => FrontmatterMutationResult): void => {
    if (!isEditableMarkdown || hasYamlSyntaxError) return
    const result = mutate()
    if (result.applied && result.content !== content) {
      onChangeContent(result.content)
    }
  }

  const handleUpdateField = (key: string, nextValue: FrontmatterFieldValue | null): void =>
    applyMutation(() => applyFrontmatterValues(content, { [key]: nextValue }))

  const handleAddFrontmatter = (): void =>
    applyMutation(() => applyFrontmatterValues(content, {}, { createIfMissing: true }))

  const handleRemoveFrontmatter = (): void =>
    applyMutation(() => removeFrontmatterBlock(content))

  const headerBadges =
    isEditableMarkdown && (schema !== null || issueCount > 0) ? (
      <span className="properties-header-badges">
        {schema !== null && (
          <span
            className="properties-count-badge"
            aria-label={`채워진 속성 ${filledCount}/${totalCount}`}
          >
            {filledCount}/{totalCount}
          </span>
        )}
        {issueCount > 0 && (
          <span
            className="properties-warning-badge"
            title={`유효성 경고 ${issueCount}건`}
            aria-label={`유효성 경고 ${issueCount}건`}
          >
            ⚠ {issueCount}
          </span>
        )}
      </span>
    ) : undefined

  const headerActions = onOpenSchemaModal ? (
    <div className="properties-header-actions">
      <button
        type="button"
        className="icon-btn properties-manage-btn"
        aria-label="스키마 관리"
        title={canManageSchema ? '스키마 관리' : '워크스페이스를 먼저 열어주세요.'}
        disabled={!canManageSchema}
        onClick={(event) => {
          event.stopPropagation()
          onOpenSchemaModal()
        }}
      >
        <Settings size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  ) : undefined

  const renderBody = () => {
    if (!hasActiveDocument) {
      return <p className="properties-empty-text">열린 문서가 없습니다.</p>
    }
    if (!isEditableMarkdown || !parsed) {
      return <p className="properties-empty-text">마크다운 문서에서만 문서 속성을 지원합니다.</p>
    }

    return (
      <DocumentPropertiesForm
        key={documentKey ?? documentName ?? 'active-doc'}
        idPrefix={idPrefix}
        parsed={parsed}
        schemaResult={schemaResult}
        fieldValuesByKey={fieldValuesByKey}
        isSchemaLoading={isSchemaLoading}
        canManageSchema={canManageSchema}
        hasYamlSyntaxError={hasYamlSyntaxError}
        onCreateDefaultSchema={onCreateDefaultSchema}
        onRequestFieldValues={onRequestFieldValues}
        onOpenSchemaModal={onOpenSchemaModal}
        onOpenSchemaRawJson={onOpenSchemaRawJson}
        onAddFrontmatter={handleAddFrontmatter}
        onRemoveFrontmatter={handleRemoveFrontmatter}
        onUpdateField={handleUpdateField}
      />
    )
  }

  return (
    <SidebarAccordionSection
      title="문서 속성"
      ariaLabel="문서 속성"
      badge={headerBadges}
      headerActions={headerActions}
      isExpanded={isExpanded}
      flexRatio={flexRatio}
      onToggle={onToggleExpanded}
    >
      {renderBody()}
    </SidebarAccordionSection>
  )
})
