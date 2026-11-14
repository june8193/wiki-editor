import { FormEvent, useMemo, useState } from 'react'
import {
  type CustomCommandConfig,
  type ThemeMode,
  validateCustomCommandTrigger
} from '@shared/config'
import { expandSlashTemplate } from '../editor/SlashCommandEngine'
import { MarkdownPreview } from './MarkdownPreview'

interface CustomCommandsSectionProps {
  customCommands: readonly CustomCommandConfig[]
  theme: ThemeMode
  previewTitle?: string
  onSaveCustomCommands: (nextCommands: CustomCommandConfig[]) => Promise<boolean> | boolean
}

function isSameTrigger(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Settings UI section for listing, adding, editing, deleting, validating, and live-previewing
 * custom slash commands persisted in global config.json.
 */
export function CustomCommandsSection({
  customCommands,
  theme,
  previewTitle,
  onSaveCustomCommands
}: CustomCommandsSectionProps) {
  const [editingTrigger, setEditingTrigger] = useState<string | null>(null)
  const [triggerInput, setTriggerInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [descriptionInput, setDescriptionInput] = useState('')
  const [templateInput, setTemplateInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const resetForm = (): void => {
    setEditingTrigger(null)
    setTriggerInput('')
    setLabelInput('')
    setDescriptionInput('')
    setTemplateInput('')
    setFormError(null)
  }

  const startEdit = (cmd: CustomCommandConfig): void => {
    setEditingTrigger(cmd.trigger)
    setTriggerInput(cmd.trigger)
    setLabelInput(cmd.label)
    setDescriptionInput(cmd.description ?? '')
    setTemplateInput(cmd.template)
    setFormError(null)
  }

  const handleDelete = async (trigger: string): Promise<void> => {
    if (isSubmitting) return
    setIsSubmitting(true)
    try {
      const nextCommands = customCommands.filter((cmd) => !isSameTrigger(cmd.trigger, trigger))
      const ok = await onSaveCustomCommands(nextCommands)
      if (ok && editingTrigger && isSameTrigger(editingTrigger, trigger)) {
        resetForm()
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    const otherTriggers = customCommands
      .filter((cmd) => editingTrigger === null || !isSameTrigger(cmd.trigger, editingTrigger))
      .map((cmd) => cmd.trigger)

    const triggerError = validateCustomCommandTrigger(triggerInput, otherTriggers)
    if (triggerError) {
      setFormError(triggerError)
      return
    }

    const trimmedLabel = labelInput.trim()
    if (trimmedLabel.length === 0) {
      setFormError('라벨을 입력하세요.')
      return
    }

    const trimmedDesc = descriptionInput.trim()
    const nextCommand: CustomCommandConfig = {
      trigger: triggerInput,
      label: trimmedLabel,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
      template: templateInput
    }

    const nextCommands =
      editingTrigger !== null
        ? customCommands.map((cmd) => (isSameTrigger(cmd.trigger, editingTrigger) ? nextCommand : cmd))
        : [...customCommands, nextCommand]

    setIsSubmitting(true)
    try {
      const ok = await onSaveCustomCommands(nextCommands)
      if (ok) {
        resetForm()
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const expandedPreview = useMemo(
    () =>
      expandSlashTemplate(templateInput, {
        title: previewTitle && previewTitle !== 'Untitled' ? previewTitle : '문서 제목'
      }),
    [previewTitle, templateInput]
  )

  return (
    <section className="settings-section custom-commands-section" aria-label="커스텀 명령어 관리">
      <div className="custom-commands-header">
        <h3 className="settings-section-title">커스텀 명령어</h3>
        <button type="button" className="btn btn-sm" onClick={resetForm}>
          새 명령어
        </button>
      </div>

      <p className="settings-description">
        에디터에서 <code>/트리거</code>를 입력해 스니펫을 삽입합니다.{' '}
        <code>{'{{cursor}}'}</code>, <code>{'{{date}}'}</code>, <code>{'{{title}}'}</code> 치환을
        지원합니다.
      </p>

      <ul className="custom-command-list" aria-label="커스텀 명령어 목록">
        {customCommands.length === 0 ? (
          <li className="custom-command-empty">등록된 커스텀 명령어가 없습니다.</li>
        ) : (
          customCommands.map((cmd) => (
            <li
              key={cmd.trigger}
              className={`custom-command-item${
                editingTrigger !== null && isSameTrigger(editingTrigger, cmd.trigger) ? ' is-editing' : ''
              }`}
            >
              <div className="custom-command-item-info">
                <code className="custom-command-trigger">/{cmd.trigger}</code>
                <span className="custom-command-label">{cmd.label}</span>
                {cmd.description ? (
                  <span className="custom-command-desc">{cmd.description}</span>
                ) : null}
              </div>
              <div className="custom-command-item-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`/${cmd.trigger} 수정`}
                  disabled={isSubmitting}
                  onClick={() => startEdit(cmd)}
                >
                  수정
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  aria-label={`/${cmd.trigger} 삭제`}
                  disabled={isSubmitting}
                  onClick={() => void handleDelete(cmd.trigger)}
                >
                  삭제
                </button>
              </div>
            </li>
          ))
        )}
      </ul>

      <form className="custom-command-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="custom-command-field">
          <label htmlFor="custom-command-trigger">트리거명 (/ 제외)</label>
          <input
            id="custom-command-trigger"
            type="text"
            value={triggerInput}
            onChange={(e) => {
              setTriggerInput(e.target.value)
              setFormError(null)
            }}
            placeholder="예: function"
          />
        </div>

        <div className="custom-command-field">
          <label htmlFor="custom-command-label">라벨</label>
          <input
            id="custom-command-label"
            type="text"
            value={labelInput}
            onChange={(e) => {
              setLabelInput(e.target.value)
              setFormError(null)
            }}
            placeholder="예: Function 문서"
          />
        </div>

        <div className="custom-command-field">
          <label htmlFor="custom-command-description">설명 (선택)</label>
          <input
            id="custom-command-description"
            type="text"
            value={descriptionInput}
            onChange={(e) => setDescriptionInput(e.target.value)}
            placeholder="예: 함수 시그니처와 매개변수 설명 템플릿"
          />
        </div>

        <div className="custom-command-field">
          <label htmlFor="custom-command-template">마크다운 템플릿</label>
          <textarea
            id="custom-command-template"
            rows={5}
            value={templateInput}
            onChange={(e) => setTemplateInput(e.target.value)}
            placeholder={'예: ### Function: {{cursor}}\n\n- 작성일: {{date}}\n- 문서: {{title}}'}
          />
        </div>

        <div className="custom-command-preview-wrapper">
          <span className="custom-command-preview-label">미리보기 (치환 결과)</span>
          <div className="custom-command-preview" data-testid="custom-command-preview">
            {templateInput.length > 0 ? (
              <MarkdownPreview content={expandedPreview.text} scrollTop={0} theme={theme} />
            ) : (
              <p className="settings-description">템플릿을 입력하면 미리보기가 표시됩니다.</p>
            )}
          </div>
        </div>

        {formError && (
          <p
            className="settings-validation-error"
            data-testid="custom-command-error"
            aria-live="polite"
          >
            {formError}
          </p>
        )}

        <div className="custom-command-form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={isSubmitting}>
            {editingTrigger !== null ? '명령어 저장' : '명령어 추가'}
          </button>
          {editingTrigger !== null && (
            <button type="button" className="btn btn-sm" onClick={resetForm}>
              취소
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
