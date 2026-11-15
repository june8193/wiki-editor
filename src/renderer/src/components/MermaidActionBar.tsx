import { Check, Copy } from 'lucide-react'
import type { MermaidActionId } from '../hooks/useMermaidDiagramActions'

export interface MermaidActionBarProps {
  variant: 'floating' | 'inline'
  isVisible?: boolean
  canCopyCode: boolean
  activeAction: MermaidActionId | null
  completedAction: MermaidActionId | null
  onCopyCode: () => void | Promise<void>
}

export interface MermaidActionErrorAlertProps {
  message: string | null
}

/**
 * Shared toolbar for Mermaid blocks rendered either as a floating overlay in
 * Preview/Split modes or inline inside the WYSIWYG block header.
 */
export function MermaidActionBar({
  variant,
  isVisible = false,
  canCopyCode,
  activeAction,
  completedAction,
  onCopyCode
}: MermaidActionBarProps) {
  const isCopyBusy = activeAction === 'copy-code'
  const isCopyCompleted = completedAction === 'copy-code'
  const shouldBeVisible = Boolean(isVisible || activeAction !== null || completedAction !== null)

  const variantClass = variant === 'floating' ? 'is-floating' : 'is-inline'
  const visibleClass = shouldBeVisible ? ' is-visible' : ''

  return (
    <div
      role="toolbar"
      aria-label="Mermaid 다이어그램 작업"
      className={`mermaid-action-bar ${variantClass}${visibleClass}`}
    >
      <button
        type="button"
        className={`mermaid-action-btn${isCopyCompleted ? ' is-copied' : ''}`}
        aria-label="코드 복사"
        title={isCopyCompleted ? '복사됨' : '코드 복사'}
        disabled={!canCopyCode}
        aria-busy={isCopyBusy || undefined}
        onClick={() => {
          void onCopyCode()
        }}
      >
        {isCopyCompleted ? (
          <>
            <Check size={14} strokeWidth={2} aria-hidden="true" />
            <span className="mermaid-action-feedback">복사됨</span>
          </>
        ) : (
          <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
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
