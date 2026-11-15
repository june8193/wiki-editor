import { normalizeWorkspacePath } from './workspace'

export type DocumentKind = 'workspace' | 'config'

export interface DocumentBuffer {
  key: string
  kind: DocumentKind
  path: string
  name: string
  content: string
  savedContent: string
  isDirty: boolean
  version: number
  isSaving: boolean
}

export interface OpenBufferInput {
  kind: DocumentKind
  path: string
  name?: string
  content: string
}

export interface BufferKeyRemap {
  oldKey: string
  newKey: string
}

export type DocumentBufferSnapshot = Readonly<Record<string, DocumentBuffer>>

export interface SharedBufferStateSnapshot {
  buffers: DocumentBufferSnapshot
  tabCounts: Readonly<Record<string, number>>
}

export interface SaveBufferResult {
  ok: boolean
  buffer: DocumentBuffer | null
  errorMessage?: string
}

export interface ReconcileBuffersResult {
  warnings: string[]
  closedKeys: string[]
}

export type SharedBufferHubEvent =
  | {
      type: 'state-changed'
      snapshot: SharedBufferStateSnapshot
    }
  | {
      type: 'paths-remapped'
      snapshot: SharedBufferStateSnapshot
      remappings: BufferKeyRemap[]
    }
  | {
      type: 'buffers-closed'
      snapshot: SharedBufferStateSnapshot
      closedKeys: string[]
    }
  | {
      type: 'workspace-saved'
      key: string
      path: string
    }
  | {
      type: 'save-error'
      key: string
      kind: DocumentKind
      path: string
      message: string
    }

export function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

// Electron contextBridge strips Error subclasses/errno codes, so deleted workspace files match localized/ENOENT messages.
export function isMissingWorkspaceFileError(error: unknown): boolean {
  const message = toErrorMessage(error, '')
  return (
    message.includes('경로를 찾을 수 없습니다') ||
    message.includes('파일을 찾을 수 없습니다') ||
    message.includes('ENOENT')
  )
}

export function isKeyNestedOrSame(candidateKey: string, parentKey: string): boolean {
  if (!candidateKey || !parentKey) return false
  if (candidateKey === parentKey) return true
  return parentKey.endsWith('/')
    ? candidateKey.startsWith(parentKey)
    : candidateKey.startsWith(`${parentKey}/`)
}

export function buildRemappedPath(
  currentPath: string,
  oldPrefix: string,
  newPrefix: string
): string {
  const normOld = normalizeWorkspacePath(oldPrefix)
  const normCurrent = normalizeWorkspacePath(currentPath)
  const suffix = normCurrent.slice(normOld.length)
  if (!suffix) {
    return newPrefix
  }
  const usePosixSep = newPrefix.includes('/') && !newPrefix.includes('\\')
  const normalizedSuffix = usePosixSep ? suffix.replace(/\\/g, '/') : suffix.replace(/\//g, '\\')
  return `${newPrefix.replace(/[\\/]+$/, '')}${normalizedSuffix}`
}
