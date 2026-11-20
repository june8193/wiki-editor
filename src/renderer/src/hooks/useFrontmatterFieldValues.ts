import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  collectAllowCustomMultiSelectFields,
  isFrontmatterDocumentFileName,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { useWikiApi } from './useWikiApi'

const EMPTY_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {}

function areFieldValuesEqual(
  left: Readonly<Record<string, readonly string[]>>,
  right: Readonly<Record<string, readonly string[]>>
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) {
    return false
  }
  for (const key of leftKeys) {
    const a = left[key]
    const b = right[key]
    if (!b || a.length !== b.length) {
      return false
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false
      }
    }
  }
  return true
}

function collectWorkspaceMarkdownBufferVersions(
  buffers: Readonly<Record<string, { key: string; kind: string; contentKind: string; name: string; version: number }>>
): Map<string, number> {
  const nextVersions = new Map<string, number>()
  for (const buffer of Object.values(buffers)) {
    if (
      buffer.kind === 'workspace' &&
      buffer.contentKind === 'text' &&
      isFrontmatterDocumentFileName(buffer.name)
    ) {
      nextVersions.set(buffer.key, buffer.version)
    }
  }
  return nextVersions
}

export interface UseFrontmatterFieldValuesOptions {
  workspaceRootPath: string | null
  schema: WorkspaceFrontmatterSchema | null
  activeDocumentKey?: string | null
}

/**
 * Loads and refreshes live workspace `allowCustom` `multi-select` field value suggestions
 * (schema options + disk and unsaved open buffers) within the active window's workspace session.
 */
export function useFrontmatterFieldValues({
  workspaceRootPath,
  schema,
  activeDocumentKey = null
}: UseFrontmatterFieldValuesOptions) {
  const wikiApi = useWikiApi()
  const frontmatterApi = wikiApi.frontmatter
  const getFieldValues = frontmatterApi?.getFieldValues
  const isAuxiliary = wikiApi.window?.role === 'auxiliary'

  const [valuesByField, setValuesByField] =
    useState<Readonly<Record<string, readonly string[]>>>(EMPTY_FIELD_VALUES)

  const allowCustomFields = useMemo(
    () => collectAllowCustomMultiSelectFields(schema),
    [schema]
  )
  const hasAllowCustomFields = allowCustomFields.length > 0

  const isMountedRef = useRef(true)
  const seqRef = useRef(0)
  const workspaceRootRef = useRef(workspaceRootPath)
  workspaceRootRef.current = workspaceRootPath
  const hasAllowCustomRef = useRef(hasAllowCustomFields)
  hasAllowCustomRef.current = hasAllowCustomFields
  const activeDocumentKeyRef = useRef(activeDocumentKey)
  activeDocumentKeyRef.current = activeDocumentKey
  const lastSeenBufferVersionsRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const clearFieldValues = useCallback((): void => {
    seqRef.current += 1
    setValuesByField((prev) => (Object.keys(prev).length === 0 ? prev : EMPTY_FIELD_VALUES))
  }, [])

  const refreshFieldValues = useCallback((): void => {
    if (!getFieldValues || !hasAllowCustomRef.current) {
      clearFieldValues()
      return
    }
    const capturedRoot = workspaceRootRef.current
    if (!isAuxiliary && !capturedRoot) {
      clearFieldValues()
      return
    }

    const seq = ++seqRef.current
    void getFieldValues().then(
      (response) => {
        if (
          !isMountedRef.current ||
          seq !== seqRef.current ||
          (!isAuxiliary && workspaceRootRef.current !== capturedRoot)
        ) {
          return
        }
        const nextValues = response?.valuesByField ?? EMPTY_FIELD_VALUES
        setValuesByField((prev) => (areFieldValuesEqual(prev, nextValues) ? prev : nextValues))
      },
      () => {
        // Ignore transient cancellation/closed-workspace errors; schema/workspace hooks report fatal errors.
      }
    )
  }, [clearFieldValues, getFieldValues, isAuxiliary])

  useEffect(() => {
    if (!hasAllowCustomFields || (!isAuxiliary && !workspaceRootPath)) {
      clearFieldValues()
      return
    }
    refreshFieldValues()
  }, [activeDocumentKey, clearFieldValues, hasAllowCustomFields, isAuxiliary, refreshFieldValues, schema, workspaceRootPath])

  useEffect(() => {
    if (!hasAllowCustomFields || (!isAuxiliary && !workspaceRootPath)) {
      lastSeenBufferVersionsRef.current.clear()
      return
    }
    lastSeenBufferVersionsRef.current.clear()
    const unsubscribeWorkspace = wikiApi.workspace.onChanged(() => {
      refreshFieldValues()
    })
    const unsubscribeBuffers = wikiApi.buffer.onEvent((event) => {
      if (
        event.type === 'workspace-saved' ||
        event.type === 'buffers-closed' ||
        event.type === 'paths-remapped' ||
        event.type === 'buffers-force-synced'
      ) {
        if ('snapshot' in event) {
          lastSeenBufferVersionsRef.current = collectWorkspaceMarkdownBufferVersions(
            event.snapshot.buffers
          )
        }
        refreshFieldValues()
        return
      }
      if (event.type === 'state-changed') {
        const nextVersions = collectWorkspaceMarkdownBufferVersions(event.snapshot.buffers)
        let otherDocumentChanged = false
        for (const [key, version] of nextVersions.entries()) {
          if (
            key !== activeDocumentKeyRef.current &&
            lastSeenBufferVersionsRef.current.get(key) !== version
          ) {
            otherDocumentChanged = true
            break
          }
        }
        lastSeenBufferVersionsRef.current = nextVersions
        if (otherDocumentChanged) {
          refreshFieldValues()
        }
      }
    })
    return () => {
      unsubscribeWorkspace()
      unsubscribeBuffers()
    }
  }, [hasAllowCustomFields, isAuxiliary, refreshFieldValues, wikiApi, workspaceRootPath])

  return {
    valuesByField,
    refreshFieldValues
  }
}
