import { useCallback, useEffect, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import {
  DEFAULT_SEARCH_MATCH_OPTIONS,
  type SearchMatchOptions,
  type WorkspaceSearchResponse
} from '@shared/search'
import { getWorkspacePathKey } from '@shared/workspace'
import { useWikiApi } from './useWikiApi'

export const DEFAULT_WORKSPACE_SEARCH_DEBOUNCE_MS = 200

export interface UseWorkspaceSearchOptions {
  workspaceRootPath: string | null
  debounceMs?: number
}

/**
 * Manages workspace search query, matching options, 200ms IME-safe debounced IPC search,
 * per-file result collapse state, and automatic reset when switching workspaces.
 */
export function useWorkspaceSearch({
  workspaceRootPath,
  debounceMs = DEFAULT_WORKSPACE_SEARCH_DEBOUNCE_MS
}: UseWorkspaceSearchOptions) {
  const wikiApi = useWikiApi()
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchMatchOptions>(DEFAULT_SEARCH_MATCH_OPTIONS)
  const [response, setResponse] = useState<WorkspaceSearchResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [collapsedFileKeys, setCollapsedFileKeys] = useState<ReadonlySet<string>>(() => new Set())

  const mountedRef = useRef<boolean>(true)
  const isComposingRef = useRef<boolean>(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeqRef = useRef<number>(0)
  const queryRef = useRef<string>(query)
  const optionsRef = useRef<SearchMatchOptions>(options)
  const workspaceRootPathRef = useRef<string | null>(workspaceRootPath)
  const prevWorkspaceKeyRef = useRef<string | null>(
    workspaceRootPath ? getWorkspacePathKey(workspaceRootPath) : null
  )

  queryRef.current = query
  optionsRef.current = options
  workspaceRootPathRef.current = workspaceRootPath

  const clearDebounceTimer = useCallback((): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const resetResults = useCallback((): void => {
    searchSeqRef.current += 1
    setResponse(null)
    setErrorMessage(null)
    setIsSearching(false)
    setCollapsedFileKeys(new Set())
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearDebounceTimer()
      searchSeqRef.current += 1
    }
  }, [clearDebounceTimer])

  useEffect(() => {
    const nextKey = workspaceRootPath ? getWorkspacePathKey(workspaceRootPath) : null
    if (nextKey === prevWorkspaceKeyRef.current) {
      return
    }
    prevWorkspaceKeyRef.current = nextKey
    clearDebounceTimer()
    searchSeqRef.current += 1
    isComposingRef.current = false
    queryRef.current = ''
    optionsRef.current = DEFAULT_SEARCH_MATCH_OPTIONS
    setQuery('')
    setOptions(DEFAULT_SEARCH_MATCH_OPTIONS)
    setResponse(null)
    setErrorMessage(null)
    setIsSearching(false)
    setCollapsedFileKeys(new Set())
  }, [clearDebounceTimer, workspaceRootPath])

  const executeSearch = useCallback(
    async (targetQuery: string, targetOptions: SearchMatchOptions): Promise<void> => {
      clearDebounceTimer()
      const capturedRoot = workspaceRootPathRef.current
      if (!capturedRoot || targetQuery.length === 0) {
        resetResults()
        return
      }

      const searchApi = wikiApi.workspace.search
      if (!searchApi) {
        searchSeqRef.current += 1
        setResponse(null)
        setErrorMessage('워크스페이스 검색 기능을 사용할 수 없습니다.')
        setIsSearching(false)
        setCollapsedFileKeys(new Set())
        return
      }

      const seq = ++searchSeqRef.current
      setErrorMessage(null)
      setIsSearching(true)

      try {
        const nextResponse = await searchApi({
          query: targetQuery,
          options: targetOptions
        })
        if (
          !mountedRef.current ||
          seq !== searchSeqRef.current ||
          workspaceRootPathRef.current !== capturedRoot
        ) {
          return
        }
        setIsSearching(false)
        if (nextResponse.error) {
          setResponse(null)
          setErrorMessage(nextResponse.error)
          setCollapsedFileKeys(new Set())
          return
        }
        setResponse(nextResponse)
        setErrorMessage(null)
        setCollapsedFileKeys(new Set())
      } catch (error: unknown) {
        if (
          !mountedRef.current ||
          seq !== searchSeqRef.current ||
          workspaceRootPathRef.current !== capturedRoot
        ) {
          return
        }
        setIsSearching(false)
        setResponse(null)
        setErrorMessage(toErrorMessage(error, '워크스페이스 검색에 실패했습니다.'))
        setCollapsedFileKeys(new Set())
      }
    },
    [clearDebounceTimer, resetResults, wikiApi]
  )

  const scheduleDebouncedSearch = useCallback(
    (nextQuery: string): void => {
      clearDebounceTimer()
      if (!workspaceRootPathRef.current || nextQuery.length === 0) {
        resetResults()
        return
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        if (isComposingRef.current) {
          return
        }
        void executeSearch(queryRef.current, optionsRef.current)
      }, debounceMs)
    },
    [clearDebounceTimer, debounceMs, executeSearch, resetResults]
  )

  const onQueryChange = useCallback(
    (nextQuery: string, isComposingEvent: boolean): void => {
      queryRef.current = nextQuery
      setQuery(nextQuery)
      if (isComposingEvent || isComposingRef.current) {
        clearDebounceTimer()
        return
      }
      scheduleDebouncedSearch(nextQuery)
    },
    [clearDebounceTimer, scheduleDebouncedSearch]
  )

  const onCompositionStart = useCallback((): void => {
    isComposingRef.current = true
    clearDebounceTimer()
  }, [clearDebounceTimer])

  const onCompositionEnd = useCallback(
    (finalQuery: string): void => {
      isComposingRef.current = false
      queryRef.current = finalQuery
      setQuery(finalQuery)
      scheduleDebouncedSearch(finalQuery)
    },
    [scheduleDebouncedSearch]
  )

  const onSubmitSearch = useCallback((): void => {
    if (isComposingRef.current) {
      return
    }
    void executeSearch(queryRef.current, optionsRef.current)
  }, [executeSearch])

  const onToggleOption = useCallback(
    (optionKey: keyof SearchMatchOptions): void => {
      const nextOptions: SearchMatchOptions = {
        ...optionsRef.current,
        [optionKey]: !optionsRef.current[optionKey]
      }
      optionsRef.current = nextOptions
      setOptions(nextOptions)
      if (!isComposingRef.current && workspaceRootPathRef.current && queryRef.current.length > 0) {
        void executeSearch(queryRef.current, nextOptions)
      }
    },
    [executeSearch]
  )

  const onToggleFileCollapsed = useCallback((filePath: string): void => {
    const fileKey = getWorkspacePathKey(filePath)
    if (!fileKey) return
    setCollapsedFileKeys((prev) => {
      const next = new Set(prev)
      if (next.has(fileKey)) {
        next.delete(fileKey)
      } else {
        next.add(fileKey)
      }
      return next
    })
  }, [])

  return {
    query,
    options,
    response,
    errorMessage,
    isSearching,
    collapsedFileKeys,
    onQueryChange,
    onCompositionStart,
    onCompositionEnd,
    onSubmitSearch,
    onToggleOption,
    onToggleFileCollapsed
  }
}
