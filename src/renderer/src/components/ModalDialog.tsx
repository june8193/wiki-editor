import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { isEventOutsideShell } from '../utils/workspaceSearch'

export interface ModalDialogProps {
  ariaLabel: string
  backdropClassName?: string
  dialogClassName?: string
  isDismissDisabled?: boolean
  shellRef?: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}

/**
 * Centered modal backdrop and focusable dialog container with Escape and backdrop dismissal.
 */
export function ModalDialog({
  ariaLabel,
  backdropClassName,
  dialogClassName,
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
    dialogRef.current?.focus()
  }, [])

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
      className={backdropClassName ? `modal-backdrop ${backdropClassName}` : 'modal-backdrop'}
      role="presentation"
      onClick={(event) => {
        if (!isDismissDisabled && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        ref={dialogRef}
        className={dialogClassName ? `modal-dialog ${dialogClassName}` : 'modal-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
