interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm: () => void
  onSecondary?: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  secondaryLabel,
  onConfirm,
  onSecondary,
  onCancel
}: ConfirmDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="confirm-dialog-title" className="modal-title">
          {title}
        </h3>
        <p id="confirm-dialog-message" className="modal-message">
          {message}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            취소
          </button>
          {secondaryLabel && onSecondary && (
            <button type="button" className="btn" onClick={onSecondary}>
              {secondaryLabel}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
