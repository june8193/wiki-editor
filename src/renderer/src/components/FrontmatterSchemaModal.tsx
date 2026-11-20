import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import {
  createDefaultFrontmatterSchema,
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  type FrontmatterFieldType,
  type FrontmatterSchemaLoadResult,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { toErrorMessage } from '@shared/errors'
import {
  createEmptySchemaFieldDraft,
  createEmptySchemaOptionDraft,
  createSchemaDraftFields,
  FRONTMATTER_FIELD_TYPE_OPTIONS,
  isOptionBasedFieldType,
  moveArrayItem,
  normalizePickerHexColor,
  type SchemaFieldDraft,
  type SchemaFieldValidationErrors,
  type SchemaOptionDraft,
  validateAndBuildSchemaDraft
} from '../utils/frontmatterSchemaDraft'
import { ModalDialog } from './ModalDialog'

export interface FrontmatterSchemaModalProps {
  schemaResult: FrontmatterSchemaLoadResult | null
  isDismissDisabled?: boolean
  shellRef?: RefObject<HTMLDivElement | null>
  onSaveSchema: (schema: WorkspaceFrontmatterSchema) => Promise<FrontmatterSchemaLoadResult>
  onOpenRawJson: () => Promise<void> | void
  onClose: () => void
}

const EMPTY_FIELD_ERRORS: SchemaFieldValidationErrors = { optionErrors: {} }

interface SchemaReorderDeleteActionsProps {
  labelPrefix: '필드' | '옵션'
  iconSize: number
  index: number
  totalCount: number
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}

function SchemaReorderDeleteActions({
  labelPrefix,
  iconSize,
  index,
  totalCount,
  onMove,
  onDelete
}: SchemaReorderDeleteActionsProps) {
  return (
    <div className="schema-row-actions">
      <button
        type="button"
        className="icon-btn"
        aria-label={`${labelPrefix} 위로 이동`}
        title="위로 이동"
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp size={iconSize} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`${labelPrefix} 아래로 이동`}
        title="아래로 이동"
        disabled={index === totalCount - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown size={iconSize} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn schema-delete-btn"
        aria-label={`${labelPrefix} 삭제`}
        title={`${labelPrefix} 삭제`}
        onClick={onDelete}
      >
        <Trash2 size={iconSize} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
}

interface SchemaOptionRowProps {
  option: SchemaOptionDraft
  index: number
  totalCount: number
  error?: string
  onChange: (patch: Partial<SchemaOptionDraft>) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}

function SchemaOptionRow({
  option,
  index,
  totalCount,
  error,
  onChange,
  onMove,
  onDelete
}: SchemaOptionRowProps) {
  return (
    <div className="schema-option-item">
      <div className="schema-option-row" role="group" aria-label={`옵션 ${index + 1}`}>
        <input
          type="text"
          className={`schema-input schema-option-value-input${error ? ' is-invalid' : ''}`}
          aria-label="옵션 값"
          placeholder="예: in-progress"
          value={option.value}
          onChange={(event) => onChange({ value: event.target.value })}
        />
        <input
          type="color"
          className="schema-color-picker"
          aria-label="옵션 색상 선택"
          title="배지 색상 선택"
          value={normalizePickerHexColor(option.color)}
          onChange={(event) => onChange({ color: event.target.value })}
        />
        <input
          type="text"
          className="schema-input schema-option-color-input"
          aria-label="옵션 색상"
          placeholder="#64748b"
          value={option.color}
          onChange={(event) => onChange({ color: event.target.value })}
        />
        <SchemaReorderDeleteActions
          labelPrefix="옵션"
          iconSize={13}
          index={index}
          totalCount={totalCount}
          onMove={onMove}
          onDelete={onDelete}
        />
      </div>
      {error && <p className="schema-inline-error">{error}</p>}
    </div>
  )
}

interface SchemaFieldCardProps {
  field: SchemaFieldDraft
  index: number
  totalCount: number
  idPrefix: string
  errors: SchemaFieldValidationErrors
  onUpdate: (updater: (prev: SchemaFieldDraft) => SchemaFieldDraft) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
  onAddOption: () => void
}

function SchemaFieldCard({
  field,
  index,
  totalCount,
  idPrefix,
  errors,
  onUpdate,
  onMove,
  onDelete,
  onAddOption
}: SchemaFieldCardProps) {
  const keyInputId = `${idPrefix}-${field.id}-key`
  const labelInputId = `${idPrefix}-${field.id}-label`
  const typeSelectId = `${idPrefix}-${field.id}-type`
  const placeholderInputId = `${idPrefix}-${field.id}-placeholder`
  const trimmedLabel = field.label.trim()
  const groupLabel = trimmedLabel ? `필드 ${trimmedLabel}` : `새 필드 ${index + 1}`
  const showOptions = isOptionBasedFieldType(field.type)

  return (
    <div className="schema-field-card" role="group" aria-label={groupLabel}>
      <div className="schema-field-card-header">
        <span className="schema-field-index">#{index + 1}</span>
        <span className="schema-field-summary">{trimmedLabel || field.key || '새 필드'}</span>
        <SchemaReorderDeleteActions
          labelPrefix="필드"
          iconSize={14}
          index={index}
          totalCount={totalCount}
          onMove={onMove}
          onDelete={onDelete}
        />
      </div>

      <div className="schema-field-grid">
        <div className="schema-control">
          <label htmlFor={keyInputId} className="schema-control-label">
            키
          </label>
          <input
            id={keyInputId}
            type="text"
            className={`schema-input${errors.keyError ? ' is-invalid' : ''}`}
            placeholder="예: status"
            value={field.key}
            onChange={(event) => onUpdate((prev) => ({ ...prev, key: event.target.value }))}
          />
          {errors.keyError && <p className="schema-inline-error">{errors.keyError}</p>}
        </div>

        <div className="schema-control">
          <label htmlFor={labelInputId} className="schema-control-label">
            라벨
          </label>
          <input
            id={labelInputId}
            type="text"
            className={`schema-input${errors.labelError ? ' is-invalid' : ''}`}
            placeholder="예: 상태"
            value={field.label}
            onChange={(event) => onUpdate((prev) => ({ ...prev, label: event.target.value }))}
          />
          {errors.labelError && <p className="schema-inline-error">{errors.labelError}</p>}
        </div>

        <div className="schema-control">
          <label htmlFor={typeSelectId} className="schema-control-label">
            타입
          </label>
          <select
            id={typeSelectId}
            className="schema-select"
            value={field.type}
            onChange={(event) => {
              const nextType = event.target.value as FrontmatterFieldType
              onUpdate((prev) => ({
                ...prev,
                type: nextType,
                allowCustom: nextType === 'multi-select' ? prev.allowCustom : false
              }))
            }}
          >
            {FRONTMATTER_FIELD_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="schema-control">
          <label htmlFor={placeholderInputId} className="schema-control-label">
            플레이스홀더
          </label>
          <input
            id={placeholderInputId}
            type="text"
            className="schema-input"
            placeholder="입력 안내 문구 (선택)"
            value={field.placeholder}
            onChange={(event) =>
              onUpdate((prev) => ({ ...prev, placeholder: event.target.value }))
            }
          />
        </div>
      </div>

      <div className="schema-checkbox-row">
        <label className="schema-checkbox-label">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(event) =>
              onUpdate((prev) => ({ ...prev, required: event.target.checked }))
            }
          />
          <span>필수 항목</span>
        </label>

        <label className="schema-checkbox-label">
          <input
            type="checkbox"
            checked={field.showInSearchBadge}
            onChange={(event) =>
              onUpdate((prev) => ({ ...prev, showInSearchBadge: event.target.checked }))
            }
          />
          <span>검색 결과 배지 표시</span>
        </label>

        {field.type === 'multi-select' && (
          <label className="schema-checkbox-label">
            <input
              type="checkbox"
              checked={field.allowCustom}
              onChange={(event) =>
                onUpdate((prev) => ({ ...prev, allowCustom: event.target.checked }))
              }
            />
            <span>사용자 지정 값 허용 (allowCustom)</span>
          </label>
        )}
      </div>

      {showOptions && (
        <div className="schema-options-section">
          <div className="schema-options-header">
            <span className="schema-options-title">선택지 (옵션)</span>
            <button type="button" className="btn btn-sm" onClick={onAddOption}>
              + 옵션 추가
            </button>
          </div>
          {errors.optionsError && <p className="schema-inline-error">{errors.optionsError}</p>}
          {field.options.length > 0 && (
            <div className="schema-options-list">
              {field.options.map((option, optIndex) => (
                <SchemaOptionRow
                  key={option.id}
                  option={option}
                  index={optIndex}
                  totalCount={field.options.length}
                  error={errors.optionErrors[option.id]}
                  onChange={(patch) =>
                    onUpdate((prev) => ({
                      ...prev,
                      options: prev.options.map((item) =>
                        item.id === option.id ? { ...item, ...patch } : item
                      )
                    }))
                  }
                  onMove={(direction) =>
                    onUpdate((prev) => ({
                      ...prev,
                      options: moveArrayItem(prev.options, optIndex, direction)
                    }))
                  }
                  onDelete={() =>
                    onUpdate((prev) => ({
                      ...prev,
                      options: prev.options.filter((item) => item.id !== option.id)
                    }))
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Workspace modal for managing `.wiki-editor/frontmatter.json` schema definitions
 * and opening the schema file in a Raw JSON editor tab.
 */
export function FrontmatterSchemaModal({
  schemaResult,
  isDismissDisabled = false,
  shellRef,
  onSaveSchema,
  onOpenRawJson,
  onClose
}: FrontmatterSchemaModalProps) {
  const idPrefix = useId()
  const nextIdCounterRef = useRef(0)
  const nextDraftId = (): string => `fm-draft-${++nextIdCounterRef.current}`

  const [draftFields, setDraftFields] = useState<SchemaFieldDraft[]>(() =>
    createSchemaDraftFields(schemaResult?.schema ?? null, nextDraftId)
  )
  const isDraftDirtyRef = useRef(false)
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const inFlightActionRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const prevSchemaResultRef = useRef(schemaResult)
  useEffect(() => {
    if (prevSchemaResultRef.current === schemaResult) return
    prevSchemaResultRef.current = schemaResult
    if (isDraftDirtyRef.current) return
    setDraftFields(createSchemaDraftFields(schemaResult?.schema ?? null, nextDraftId))
    setHasAttemptedSave(false)
  }, [schemaResult])

  const validation = useMemo(() => validateAndBuildSchemaDraft(draftFields), [draftFields])
  const visibleErrorsByFieldId = hasAttemptedSave ? validation.errorsByFieldId : {}

  const mutateFields = (updater: (prev: SchemaFieldDraft[]) => SchemaFieldDraft[]): void => {
    isDraftDirtyRef.current = true
    setSaveError(null)
    setDraftFields(updater)
  }

  const updateFieldById = (
    fieldId: string,
    updater: (prev: SchemaFieldDraft) => SchemaFieldDraft
  ): void => {
    mutateFields((prev) => prev.map((item) => (item.id === fieldId ? updater(item) : item)))
  }

  const handleLoadDefaultTemplate = (): void => {
    mutateFields(() => createSchemaDraftFields(createDefaultFrontmatterSchema(), nextDraftId))
    setHasAttemptedSave(false)
  }

  const runLockedAction = async (
    action: () => Promise<void> | void,
    fallbackMessage: string
  ): Promise<void> => {
    if (inFlightActionRef.current) return
    inFlightActionRef.current = true
    setIsBusy(true)
    setSaveError(null)
    try {
      await action()
    } catch (error: unknown) {
      if (!isMountedRef.current) return
      setSaveError(toErrorMessage(error, fallbackMessage))
    } finally {
      inFlightActionRef.current = false
      if (isMountedRef.current) {
        setIsBusy(false)
      }
    }
  }

  const handleSave = async (): Promise<void> => {
    if (inFlightActionRef.current) return
    setHasAttemptedSave(true)
    setSaveError(null)
    if (!validation.ok) {
      return
    }

    await runLockedAction(async () => {
      await onSaveSchema(validation.schema)
      if (!isMountedRef.current) return
      isDraftDirtyRef.current = false
      onClose()
    }, '프론트매터 스키마를 저장하지 못했습니다.')
  }

  const handleOpenRawJson = async (): Promise<void> => {
    await runLockedAction(() => onOpenRawJson(), '스키마 JSON 파일을 열지 못했습니다.')
  }

  const templateBanner = !schemaResult?.exists
    ? {
        message:
          '아직 스키마 파일(.wiki-editor/frontmatter.json)이 없습니다. 필드를 추가하거나 기본 템플릿을 불러와 저장할 수 있습니다.',
        isError: false
      }
    : schemaResult.error
      ? { message: schemaResult.error, isError: true }
      : null

  return (
    <ModalDialog
      ariaLabel="프론트매터 스키마 관리"
      backdropClassName="schema-modal-backdrop"
      dialogClassName="schema-modal"
      isDismissDisabled={isDismissDisabled || isBusy}
      shellRef={shellRef}
      onClose={onClose}
    >
      <div className="schema-modal-header">
        <div className="schema-modal-title-group">
          <h2>프론트매터 스키마 관리</h2>
          <code className="schema-modal-path">
            {schemaResult?.path || FRONTMATTER_SCHEMA_RELATIVE_PATH}
          </code>
        </div>
        <button type="button" className="btn" disabled={isBusy} onClick={onClose}>
          닫기
        </button>
      </div>

      <div className="schema-modal-body">
        {saveError && (
          <div className="schema-modal-banner is-error" role="alert">
            {saveError}
          </div>
        )}

        {hasAttemptedSave && !validation.ok && (
          <div className="schema-modal-banner is-error" role="alert">
            {validation.summaryErrors.join(' ')}
          </div>
        )}

        <fieldset className="schema-modal-fieldset" disabled={isBusy}>
          {templateBanner && (
            <div
              className={`schema-modal-banner${templateBanner.isError ? ' is-error' : ''}`}
              role={templateBanner.isError ? 'alert' : undefined}
            >
              <span>{templateBanner.message}</span>
              <button type="button" className="btn btn-sm" onClick={handleLoadDefaultTemplate}>
                기본 템플릿 불러오기
              </button>
            </div>
          )}

          <div className="schema-field-list" aria-label="스키마 필드 목록">
            {draftFields.length === 0 ? (
              <p className="schema-empty-text">
                정의된 필드가 없습니다. 아래 &apos;+ 필드 추가&apos; 버튼으로 필드를 추가하세요.
              </p>
            ) : (
              draftFields.map((field, index) => (
                <SchemaFieldCard
                  key={field.id}
                  field={field}
                  index={index}
                  totalCount={draftFields.length}
                  idPrefix={idPrefix}
                  errors={visibleErrorsByFieldId[field.id] ?? EMPTY_FIELD_ERRORS}
                  onUpdate={(updater) => updateFieldById(field.id, updater)}
                  onMove={(direction) =>
                    mutateFields((prev) => moveArrayItem(prev, index, direction))
                  }
                  onDelete={() =>
                    mutateFields((prev) => prev.filter((item) => item.id !== field.id))
                  }
                  onAddOption={() =>
                    updateFieldById(field.id, (prev) => ({
                      ...prev,
                      options: [...prev.options, createEmptySchemaOptionDraft(nextDraftId)]
                    }))
                  }
                />
              ))
            )}
          </div>

          <div className="schema-add-field-row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                mutateFields((prev) => [...prev, createEmptySchemaFieldDraft(nextDraftId)])
              }
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>+ 필드 추가</span>
            </button>
          </div>
        </fieldset>
      </div>

      <div className="schema-modal-footer">
        <button
          type="button"
          className="btn"
          disabled={isBusy}
          onClick={() => void handleOpenRawJson()}
        >
          JSON 파일로 열기
        </button>
        <div className="schema-modal-footer-right">
          <button type="button" className="btn" disabled={isBusy} onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={isBusy}
            onClick={() => void handleSave()}
          >
            저장
          </button>
        </div>
      </div>
    </ModalDialog>
  )
}
