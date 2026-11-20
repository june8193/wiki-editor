import { useCallback, useEffect, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type {
  FrontmatterSchemaLoadResult,
  WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { useWikiApi } from './useWikiApi'

export interface UseFrontmatterSchemaOptions {
  workspaceRootPath: string | null
  onError: (message: string | null, error?: unknown) => void
}

/**
 * Loads, subscribes to session-scoped broadcasts for, and initializes/saves
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
  const schemaResultRef = useRef(schemaResult)
  schemaResultRef.current = schemaResult
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

  const commitSchemaResult = useCallback((result: FrontmatterSchemaLoadResult | null): void => {
    loadSeqRef.current += 1
    setSchemaResult(result)
    setIsSchemaLoading(false)
  }, [])

  useEffect(() => {
    if (!frontmatterApi || (!isAuxiliary && !workspaceRootPath)) {
      commitSchemaResult(null)
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
  }, [commitSchemaResult, frontmatterApi, isAuxiliary, workspaceRootPath])

  useEffect(() => {
    if (!frontmatterApi) return
    return frontmatterApi.onSchemaChanged((nextResult) => {
      if (!isMountedRef.current) return
      if (!isAuxiliary && !workspaceRootRef.current) return
      commitSchemaResult(nextResult)
    })
  }, [commitSchemaResult, frontmatterApi, isAuxiliary])

  const isSessionRootActive = useCallback(
    (capturedRoot: string | null): boolean =>
      isMountedRef.current && (isAuxiliary || workspaceRootRef.current === capturedRoot),
    [isAuxiliary]
  )

  const hasOpenSessionWorkspace = useCallback(
    (capturedRoot: string | null): boolean => isAuxiliary || Boolean(capturedRoot),
    [isAuxiliary]
  )

  const createDefaultSchema = useCallback((): void => {
    if (!frontmatterApi) return
    const capturedRoot = workspaceRootRef.current
    if (!hasOpenSessionWorkspace(capturedRoot)) return

    onErrorRef.current(null)
    void frontmatterApi.createDefaultSchema().then(
      (created) => {
        if (!isSessionRootActive(capturedRoot)) return
        commitSchemaResult(created)
      },
      (error: unknown) => {
        if (!isSessionRootActive(capturedRoot)) return
        onErrorRef.current(
          toErrorMessage(error, '기본 프론트매터 스키마를 생성하지 못했습니다.'),
          error
        )
      }
    )
  }, [commitSchemaResult, frontmatterApi, hasOpenSessionWorkspace, isSessionRootActive])

  const saveSchema = useCallback(
    async (nextSchema: WorkspaceFrontmatterSchema): Promise<FrontmatterSchemaLoadResult> => {
      if (!frontmatterApi) {
        throw new Error('프론트매터 스키마 API를 사용할 수 없습니다.')
      }
      const capturedRoot = workspaceRootRef.current
      if (!hasOpenSessionWorkspace(capturedRoot)) {
        throw new Error('열린 워크스페이스가 없습니다.')
      }
      const saved = await frontmatterApi.saveSchema(nextSchema)
      if (isSessionRootActive(capturedRoot)) {
        commitSchemaResult(saved)
      }
      return saved
    },
    [commitSchemaResult, frontmatterApi, hasOpenSessionWorkspace, isSessionRootActive]
  )

  const ensureSchemaFilePath = useCallback(async (): Promise<string | null> => {
    if (!frontmatterApi) return null
    const capturedRoot = workspaceRootRef.current
    if (!hasOpenSessionWorkspace(capturedRoot)) return null

    const current = schemaResultRef.current
    if (current?.exists && current.path) {
      return current.path
    }

    onErrorRef.current(null)
    try {
      const result = current?.exists
        ? await frontmatterApi.getSchema()
        : await frontmatterApi.createDefaultSchema()
      if (!isSessionRootActive(capturedRoot)) return null
      commitSchemaResult(result)
      return result.exists && result.path ? result.path : null
    } catch (error: unknown) {
      if (isSessionRootActive(capturedRoot)) {
        onErrorRef.current(
          toErrorMessage(error, '프론트매터 스키마 파일을 준비하지 못했습니다.'),
          error
        )
      }
      return null
    }
  }, [commitSchemaResult, frontmatterApi, hasOpenSessionWorkspace, isSessionRootActive])

  return {
    schemaResult,
    isSchemaLoading,
    createDefaultSchema,
    saveSchema,
    ensureSchemaFilePath
  }
}
