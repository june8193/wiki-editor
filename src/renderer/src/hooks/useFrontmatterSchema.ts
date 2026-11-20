import { useCallback, useEffect, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type { FrontmatterSchemaLoadResult } from '@shared/frontmatter'
import { useWikiApi } from './useWikiApi'

export interface UseFrontmatterSchemaOptions {
  workspaceRootPath: string | null
  onError: (message: string | null, error?: unknown) => void
}

/**
 * Loads, subscribes to session-scoped broadcasts for, and initializes
 * `.wiki-editor/frontmatter.json` across both main and auxiliary windows.
 */
export function useFrontmatterSchema({
  workspaceRootPath,
  onError
}: UseFrontmatterSchemaOptions) {
  const wikiApi = useWikiApi()
  const frontmatterApi = wikiApi.frontmatter
  const isAuxiliary = wikiApi.window?.role === 'auxiliary'

  const [schemaResult, setSchemaResult] = useState<FrontmatterSchemaLoadResult | null>(null)
  const [isSchemaLoading, setIsSchemaLoading] = useState<boolean>(false)

  const isMountedRef = useRef(true)
  const loadSeqRef = useRef(0)
  const workspaceRootRef = useRef(workspaceRootPath)
  workspaceRootRef.current = workspaceRootPath
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!frontmatterApi) {
      loadSeqRef.current += 1
      setSchemaResult(null)
      setIsSchemaLoading(false)
      return
    }
    if (!isAuxiliary && !workspaceRootPath) {
      loadSeqRef.current += 1
      setSchemaResult(null)
      setIsSchemaLoading(false)
      return
    }

    const seq = ++loadSeqRef.current
    setIsSchemaLoading(true)

    void frontmatterApi.getSchema().then(
      (result) => {
        if (!isMountedRef.current || seq !== loadSeqRef.current) return
        setSchemaResult(result)
        setIsSchemaLoading(false)
      },
      (error: unknown) => {
        if (!isMountedRef.current || seq !== loadSeqRef.current) return
        setSchemaResult(null)
        setIsSchemaLoading(false)
        if (!isAuxiliary) {
          onErrorRef.current(
            toErrorMessage(error, '프론트매터 스키마를 불러오지 못했습니다.'),
            error
          )
        }
      }
    )
  }, [frontmatterApi, isAuxiliary, workspaceRootPath])

  useEffect(() => {
    if (!frontmatterApi) return
    return frontmatterApi.onSchemaChanged((nextResult) => {
      if (!isMountedRef.current) return
      if (!isAuxiliary && !workspaceRootRef.current) return
      loadSeqRef.current += 1
      setSchemaResult(nextResult)
      setIsSchemaLoading(false)
    })
  }, [frontmatterApi, isAuxiliary])

  const createDefaultSchema = useCallback((): void => {
    if (!frontmatterApi) return
    const capturedRoot = workspaceRootRef.current
    if (!isAuxiliary && !capturedRoot) return

    onErrorRef.current(null)
    void frontmatterApi.createDefaultSchema().then(
      (created) => {
        if (!isMountedRef.current) return
        if (!isAuxiliary && workspaceRootRef.current !== capturedRoot) return
        loadSeqRef.current += 1
        setSchemaResult(created)
        setIsSchemaLoading(false)
      },
      (error: unknown) => {
        if (!isMountedRef.current) return
        if (!isAuxiliary && workspaceRootRef.current !== capturedRoot) return
        onErrorRef.current(
          toErrorMessage(error, '기본 프론트매터 스키마를 생성하지 못했습니다.'),
          error
        )
      }
    )
  }, [frontmatterApi, isAuxiliary])

  return {
    schemaResult,
    isSchemaLoading,
    createDefaultSchema
  }
}
