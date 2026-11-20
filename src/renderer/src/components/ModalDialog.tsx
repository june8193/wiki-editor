import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { isEventOutsideShell } from '../utils/workspaceSearch'

export interface ModalDialogProps {
  backdropClassName?: string
  dialogClassName?: string
  ariaLabel?: string
  ariaLabelledBy?: string
  autoFocusDialog?: boolean
  isDismissDisabled?: boolean
  shellRef?: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}

/**
 * Shared modal backdrop and accessible dialog container with Escape and backdrop dismissal.
 */
export function ModalDialog({
  backdropClassName,
  dialogClassName,
  ariaLabel,
  ariaLabelledBy,
  autoFocusDialog = true,
  isDismissDisabled = false,
  shellRef,
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
      if (event.defaultPrevented || event.key !== 'Escape' || isDismissDisabledRef.current) {
        return
      }
      if (isEventOutsideShell(event.target, shellRef?.current ?? null)) {
        return
      }
      event.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [shellRef])

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
