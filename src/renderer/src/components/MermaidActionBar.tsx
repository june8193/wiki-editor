import { Check, Copy, Image as ImageIcon } from 'lucide-react'
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
    Icon: typeof ImageIcon
    canExecute: boolean
    onTrigger: () => Promise<void>
  }> = [
    {
      id: 'copy-image',
      label: '이미지 복사',
      Icon: ImageIcon,
      canExecute: actions.canCopyImage,
      onTrigger: actions.handleCopyImage
    },
    {
      id: 'copy-code',
      label: '코드 복사',
      Icon: Copy,
      canExecute: actions.canCopyCode,
      onTrigger: actions.handleCopyCode
    }
  ]

  return (
    <div
      role="toolbar"
      aria-label="Mermaid 다이어그램 작업"
      className={`mermaid-action-bar ${variantClass}${visibleClass}`}
    >
      {actionItems.map(({ id, label, Icon, canExecute, onTrigger }) => {
        const isBusy = actions.activeAction === id
        const isCompleted = actions.completedAction === id
        return (
          <button
            key={id}
            type="button"
            className={`mermaid-action-btn${isCompleted ? ' is-copied' : ''}`}
            aria-label={label}
            title={isCompleted ? '복사됨' : label}
            disabled={!canExecute}
            aria-busy={isBusy || undefined}
            onClick={() => {
              void onTrigger()
            }}
          >
            {isCompleted ? (
              <>
                <Check size={14} strokeWidth={2} aria-hidden="true" />
                <span className="mermaid-action-feedback">복사됨</span>
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
