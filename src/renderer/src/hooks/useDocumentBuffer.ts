import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getWorkspaceDisplayName,
  isNestedOrSamePath,
  remapPathPrefix,
  WorkspaceEntry
} from '@shared/workspace'
import { toErrorMessage } from '../utils/toErrorMessage'

export interface ActiveDocument {
  kind: 'workspace' | 'config'
  path: string
  name: string
  content: string
  savedContent: string
}

export function isDocumentDirty(doc: ActiveDocument | null): boolean {
  return doc !== null && doc.content !== doc.savedContent
}

interface UseDocumentBufferOptions {
  autoSave: boolean
  autoSaveDelayMs: number
  isAutoSavePaused: boolean
  onSaveConfigRaw: (rawContent: string) => Promise<unknown>
  onError: (message: string | null) => void
}

/**
 * Manages active document content, dirty tracking, manual Ctrl+S saves, and debounced auto-save.
 */
export function useDocumentBuffer({
  autoSave,
  autoSaveDelayMs,
  isAutoSavePaused,
  onSaveConfigRaw,
  onError
}: UseDocumentBufferOptions) {
  const [activeDoc, setActiveDoc] = useState<ActiveDocument | null>(null)
  const [isSavingDoc, setIsSavingDoc] = useState<boolean>(false)

  const mountedRef = useRef<boolean>(true)
  const activeDocRef = useRef<ActiveDocument | null>(null)
  const isSavingRef = useRef<boolean>(false)
  const inFlightSavePromiseRef = useRef<Promise<boolean> | null>(null)
  const callbacksRef = useRef({ onSaveConfigRaw, onError })

  activeDocRef.current = activeDoc
  callbacksRef.current = { onSaveConfigRaw, onError }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const saveSnapshot = useCallback((snapshot: ActiveDocument): Promise<boolean> => {
    if (isSavingRef.current) {
      return inFlightSavePromiseRef.current ?? Promise.resolve(false)
    }

    isSavingRef.current = true
    setIsSavingDoc(true)
    callbacksRef.current.onError(null)

    const run = (async (): Promise<boolean> => {
      try {
        if (snapshot.kind === 'config') {
          await callbacksRef.current.onSaveConfigRaw(snapshot.content)
        } else {
          await window.wikiApi.workspace.writeFile(snapshot.path, snapshot.content)
        }

        if (!mountedRef.current) return false
        setActiveDoc((current) => {
          if (!current || current.kind !== snapshot.kind || current.path !== snapshot.path) {
            return current
          }
          const updated = { ...current, savedContent: snapshot.content }
          activeDocRef.current = updated
          return updated
        })
        return true
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'))
        }
        return false
      } finally {
        isSavingRef.current = false
        inFlightSavePromiseRef.current = null
        if (mountedRef.current) {
          setIsSavingDoc(false)
        }
      }
    })()

    inFlightSavePromiseRef.current = run
    return run
  }, [])

  const saveActiveDocument = useCallback((): void => {
    const current = activeDocRef.current
    if (!isDocumentDirty(current) || !current || isSavingRef.current) return
    void saveSnapshot({ ...current })
  }, [saveSnapshot])

  const ensureSaved = useCallback(async (): Promise<boolean> => {
    if (inFlightSavePromiseRef.current) {
      const ok = await inFlightSavePromiseRef.current
      if (!ok) return false
    }
    const latest = activeDocRef.current
    if (!latest || !isDocumentDirty(latest)) {
      return true
    }
    return saveSnapshot({ ...latest })
  }, [saveSnapshot])

  const getDirtyDocumentName = useCallback((): string | null => {
    const current = activeDocRef.current
    return isDocumentDirty(current) && current ? current.name : null
  }, [])

  const isOpenWorkspaceFile = useCallback((filePath: string): boolean => {
    const current = activeDocRef.current
    return current?.kind === 'workspace' && current.path === filePath
  }, [])

  useEffect(() => {
    if (!autoSave || isAutoSavePaused || !activeDoc) return
    if (activeDoc.kind !== 'workspace') return
    if (!isDocumentDirty(activeDoc)) return

    const snapshot: ActiveDocument = { ...activeDoc }
    const timer = window.setTimeout(() => {
      void saveSnapshot(snapshot)
    }, autoSaveDelayMs)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    autoSave,
    autoSaveDelayMs,
    isAutoSavePaused,
    activeDoc?.kind,
    activeDoc?.path,
    activeDoc?.content,
    activeDoc?.savedContent,
    saveSnapshot
  ])

  const openWorkspaceFile = useCallback(async (entry: WorkspaceEntry): Promise<void> => {
    callbacksRef.current.onError(null)
    try {
      const content = await window.wikiApi.workspace.readFile(entry.path)
      if (!mountedRef.current) return
      setActiveDoc({
        kind: 'workspace',
        path: entry.path,
        name: entry.name,
        content,
        savedContent: content
      })
    } catch (error: unknown) {
      if (mountedRef.current) {
        callbacksRef.current.onError(toErrorMessage(error, '파일을 열지 못했습니다.'))
      }
    }
  }, [])

  const openConfigDocument = useCallback(async (): Promise<void> => {
    callbacksRef.current.onError(null)
    try {
      const [resolvedPath, raw] = await Promise.all([
        window.wikiApi.config.getConfigPath(),
        window.wikiApi.config.readRaw()
      ])
      if (!mountedRef.current) return
      setActiveDoc({
        kind: 'config',
        path: resolvedPath,
        name: 'config.json',
        content: raw,
        savedContent: raw
      })
    } catch (error: unknown) {
      if (mountedRef.current) {
        callbacksRef.current.onError(toErrorMessage(error, '설정 파일을 읽지 못했습니다.'))
      }
    }
  }, [])

  const refreshCleanConfig = useCallback(async (): Promise<void> => {
    const doc = activeDocRef.current
    if (!doc || doc.kind !== 'config' || isDocumentDirty(doc)) {
      return
    }
    try {
      const raw = await window.wikiApi.config.readRaw()
      if (!mountedRef.current) return
      setActiveDoc((current) => {
        if (!current || current.kind !== 'config' || isDocumentDirty(current)) {
          return current
        }
        return { ...current, content: raw, savedContent: raw }
      })
    } catch {
      // Preserve primary error banners during background config refresh
    }
  }, [])

  const updateContent = useCallback((nextContent: string): void => {
    setActiveDoc((current) => (current ? { ...current, content: nextContent } : null))
  }, [])

  const openCreatedFileIfClean = useCallback((created: WorkspaceEntry): void => {
    if (!isDocumentDirty(activeDocRef.current)) {
      setActiveDoc({
        kind: 'workspace',
        path: created.path,
        name: created.name,
        content: '',
        savedContent: ''
      })
    }
  }, [])

  const clearWorkspaceDocument = useCallback((): void => {
    setActiveDoc((current) => (current?.kind === 'config' ? current : null))
  }, [])

  const syncRenamedPath = useCallback((oldPath: string, renamed: WorkspaceEntry): void => {
    setActiveDoc((current) => {
      if (!current || current.kind !== 'workspace') return current
      if (!isNestedOrSamePath(current.path, oldPath)) return current
      const nextPath = remapPathPrefix(current.path, oldPath, renamed.path)
      return {
        ...current,
        path: nextPath,
        name: getWorkspaceDisplayName(nextPath)
      }
    })
  }, [])

  const syncDeletedPath = useCallback((deletedPath: string): void => {
    setActiveDoc((current) => {
      if (!current || current.kind !== 'workspace') return current
      return isNestedOrSamePath(current.path, deletedPath) ? null : current
    })
  }, [])

  return {
    activeDoc,
    isSavingDoc,
    saveActiveDocument,
    ensureSaved,
    getDirtyDocumentName,
    isOpenWorkspaceFile,
    openWorkspaceFile,
    openConfigDocument,
    refreshCleanConfig,
    updateContent,
    openCreatedFileIfClean,
    clearWorkspaceDocument,
    syncRenamedPath,
    syncDeletedPath
  }
}
