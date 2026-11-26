import type { TextEncoding, UnencodableCharsInfo } from './encoding'
import { toErrorMessage } from './errors'
import { normalizeWorkspacePath } from './workspace'

export type DocumentKind = 'workspace' | 'config'
export type DocumentContentKind = 'text' | 'image'

export interface DocumentBuffer {
  key: string
  kind: DocumentKind
  contentKind: DocumentContentKind
  path: string
  name: string
  content: string
  savedContent: string
  encoding: TextEncoding
  savedEncoding: TextEncoding
  isDirty: boolean
  version: number
  isSaving: boolean
}

export type OpenBufferInput =
  | {
      kind: DocumentKind
      contentKind?: 'text'
      path: string
      name?: string
      content: string
      encoding?: TextEncoding
    }
  | {
      kind: 'workspace'
      contentKind: 'image'
      path: string
      name?: string
    }

export interface BufferKeyRemap {
  oldKey: string
  newKey: string
}

export type DocumentBufferSnapshot = Readonly<Record<string, DocumentBuffer>>

export interface SharedBufferStateSnapshot {
  buffers: DocumentBufferSnapshot
  tabCounts: Readonly<Record<string, number>>
  windowTabCounts?: Readonly<Record<number, Readonly<Record<string, number>>>>
  revision?: number
  windowId?: number
}

export const EMPTY_SHARED_BUFFER_SNAPSHOT: Readonly<SharedBufferStateSnapshot> = Object.freeze({
  buffers: Object.freeze({}),
  tabCounts: Object.freeze({}),
  windowTabCounts: Object.freeze({}),
  revision: 0
})

export interface SaveBufferOptions {
  allowLossy?: boolean
}

export interface SaveBufferResult {
  ok: boolean
  buffer: DocumentBuffer | null
  errorMessage?: string
  unencodableChars?: UnencodableCharsInfo
}

export interface SyncWindowTabsOptions {
  releasePending?: boolean
  nonBufferTabCount?: number
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
      type: 'buffers-force-synced'
      snapshot: SharedBufferStateSnapshot
      syncedKeys: string[]
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

// Electron contextBridge strips Error subclasses/errno codes, so deleted workspace files match localized/ENOENT messages.
export function isMissingWorkspaceFileError(error: unknown): boolean {
  const message = toErrorMessage(error, '')
  return (
    message.includes('경로를 찾을 수 없습니다') ||
    message.includes('파일을 찾을 수 없습니다') ||
    message.includes('폴더를 찾을 수 없습니다') ||
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
