export type ConfirmDialogTone = 'primary' | 'danger'

export interface ConfirmActionDialogRequest {
  title: string
  message: string
  confirmLabel: string
  confirmTone?: ConfirmDialogTone
}

export interface UnsavedChangesPromptRequest {
  message: string
  confirmLabel: string
  secondaryLabel: string
  onSave: () => Promise<boolean>
}

export interface UnsavedBuffersPromptTarget {
  getDirtySummary: (targetPaths?: readonly string[]) => string | null
  saveDirtyBuffers: (targetPaths?: readonly string[]) => Promise<boolean>
}

export interface UnsavedWorkspaceChangesPromptOptions {
  targetPaths?: readonly string[]
  message: (dirtySummary: string) => string
  confirmLabel: string
  secondaryLabel: string
}

export type ConfirmUnsavedChangesFn = (request: UnsavedChangesPromptRequest) => Promise<boolean>

/**
 * Prompts the user to save or discard unsaved workspace buffers when dirty targets exist,
 * returning `true` immediately when clean. Reused by both Git mutations and workspace switching.
 */
export async function promptUnsavedWorkspaceChanges(
  buffers: UnsavedBuffersPromptTarget,
  confirmUnsaved: ConfirmUnsavedChangesFn,
  options: UnsavedWorkspaceChangesPromptOptions
): Promise<boolean> {
  const dirtySummary = buffers.getDirtySummary(options.targetPaths)
  if (!dirtySummary) {
    return true
  }

  return confirmUnsaved({
    message: options.message(dirtySummary),
    confirmLabel: options.confirmLabel,
    secondaryLabel: options.secondaryLabel,
    onSave: () => buffers.saveDirtyBuffers(options.targetPaths)
  })
}
