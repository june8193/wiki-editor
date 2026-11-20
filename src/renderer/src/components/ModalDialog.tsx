import { useEffect, useRef, type ReactNode } from 'react'

export interface ModalDialogProps {
  backdropClassName?: string
  dialogClassName?: string
  ariaLabel?: string
  ariaLabelledBy?: string
  autoFocusDialog?: boolean
  isDismissDisabled?: boolean
  onClose: () => void
  children: ReactNode
}

/**
 * Shared modal backdrop and accessible dialog frame handling backdrop clicks and Escape dismissal.
 */
export function ModalDialog({
  backdropClassName,
  dialogClassName,
  ariaLabel,
  ariaLabelledBy,
  autoFocusDialog = false,
  isDismissDisabled = false,
  onClose,
  children
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const isDismissDisabledRef = useRef(isDismissDisabled)
  onCloseRef.current = onClose
  isDismissDisabledRef.current = isDismissDisabled

  useEffect(() => {
    if (autoFocusDialog) {
      dialogRef.current?.focus()
    }
  }, [autoFocusDialog])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isDismissDisabledRef.current) {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <div
      className={['modal-backdrop', backdropClassName].filter(Boolean).join(' ')}
      role="presentation"
      onClick={(event) => {
        if (!isDismissDisabled && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        ref={dialogRef}
        className={['modal-dialog', dialogClassName].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
