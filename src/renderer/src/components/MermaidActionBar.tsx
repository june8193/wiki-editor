import { Check, Copy, FileCode, Image as ImageIcon, ImageDown } from 'lucide-react'
import type { MermaidActionId, MermaidDiagramActionsState } from '../hooks/useMermaidDiagramActions'

export interface MermaidActionBarProps {
  variant: 'floating' | 'inline'
  isVisible?: boolean
  actions: MermaidDiagramActionsState
}

export interface MermaidActionErrorAlertProps {
  message: string | null
}

/**
 * Shared toolbar for Mermaid blocks rendered either as a floating overlay in
 * Preview/Split modes or inline inside the WYSIWYG block header.
 */
export function MermaidActionBar({ variant, isVisible = false, actions }: MermaidActionBarProps) {
  const shouldBeVisible =
    variant === 'floating' &&
    Boolean(isVisible || actions.activeAction !== null || actions.completedAction !== null)

  const variantClass = variant === 'floating' ? 'is-floating' : 'is-inline'
  const visibleClass = shouldBeVisible ? ' is-visible' : ''

  const actionItems: Array<{
    id: MermaidActionId
    label: string
    feedbackLabel: '복사됨' | '저장됨'
    completedClass: 'is-copied' | 'is-saved'
    Icon: typeof ImageIcon
    canExecute: boolean
    onTrigger: () => Promise<void>
  }> = [
    {
      id: 'copy-image',
      label: '이미지 복사',
      feedbackLabel: '복사됨',
      completedClass: 'is-copied',
      Icon: ImageIcon,
      canExecute: actions.canExport,
      onTrigger: actions.handleCopyImage
    },
    {
      id: 'copy-code',
      label: '코드 복사',
      feedbackLabel: '복사됨',
      completedClass: 'is-copied',
      Icon: Copy,
      canExecute: actions.canCopyCode,
      onTrigger: actions.handleCopyCode
    },
    {
      id: 'save-png',
      label: 'PNG 저장',
      feedbackLabel: '저장됨',
      completedClass: 'is-saved',
      Icon: ImageDown,
      canExecute: actions.canExport,
      onTrigger: actions.handleSavePng
    },
    {
      id: 'save-svg',
      label: 'SVG 저장',
      feedbackLabel: '저장됨',
      completedClass: 'is-saved',
      Icon: FileCode,
      canExecute: actions.canExport,
      onTrigger: actions.handleSaveSvg
    }
  ]

  return (
    <div
      role="toolbar"
      aria-label="Mermaid 다이어그램 작업"
      className={`mermaid-action-bar ${variantClass}${visibleClass}`}
    >
      {actionItems.map(({ id, label, feedbackLabel, completedClass, Icon, canExecute, onTrigger }) => {
        const isBusy = actions.activeAction === id
        const isCompleted = actions.completedAction === id
        return (
          <button
            key={id}
            type="button"
            className={`mermaid-action-btn${isCompleted ? ` ${completedClass}` : ''}`}
            aria-label={label}
            title={isCompleted ? feedbackLabel : label}
            disabled={!canExecute}
            aria-busy={isBusy || undefined}
            onClick={() => {
              void onTrigger()
            }}
          >
            {isCompleted ? (
              <>
                <Check size={14} strokeWidth={2} aria-hidden="true" />
                <span className="mermaid-action-feedback">{feedbackLabel}</span>
              </>
            ) : (
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Inline alert displaying Mermaid action failures scoped to the originating block.
 */
export function MermaidActionErrorAlert({ message }: MermaidActionErrorAlertProps) {
  if (message === null) {
    return null
  }

  return (
    <div className="mermaid-action-error" role="alert">
      {message}
    </div>
  )
}
