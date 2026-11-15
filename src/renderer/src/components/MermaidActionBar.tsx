import { Check, Copy } from 'lucide-react'

export interface MermaidActionBarProps {
  variant: 'floating' | 'inline'
  isVisible?: boolean
  canCopyCode: boolean
  isCopyingCode: boolean
  isCopiedCode: boolean
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
  isCopyingCode,
  isCopiedCode,
  onCopyCode
}: MermaidActionBarProps) {
  const shouldBeVisible =
    variant === 'floating' && Boolean(isVisible || isCopyingCode || isCopiedCode)

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
        className={`mermaid-action-btn${isCopiedCode ? ' is-copied' : ''}`}
        aria-label="코드 복사"
        title={isCopiedCode ? '복사됨' : '코드 복사'}
        disabled={!canCopyCode}
        aria-busy={isCopyingCode || undefined}
        onClick={() => {
          void onCopyCode()
        }}
      >
        {isCopiedCode ? (
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
