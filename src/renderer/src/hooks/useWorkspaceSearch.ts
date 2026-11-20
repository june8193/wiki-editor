import { useCallback, useEffect, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type {
  FrontmatterFieldDefinition,
  FrontmatterFilterCondition,
  WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import {
  DEFAULT_SEARCH_MATCH_OPTIONS,
  type SearchMatchOptions,
  type WorkspaceSearchResponse,
  type WorkspaceSearchSortSpec
} from '@shared/search'
import { getWorkspacePathKey } from '@shared/workspace'
import {
  areSearchSortsEqual,
  DEFAULT_WORKSPACE_SEARCH_SORT,
  getSearchSchemaSignature,
  reconcileFilterConditions,
  reconcileSearchSortSpec,
  type SummaryBadgeValue,
  upsertBadgeFilterCondition
} from '../utils/frontmatterFilterBar'
import { useWikiApi } from './useWikiApi'

const WORKSPACE_SEARCH_DEBOUNCE_MS = 200

export interface UseWorkspaceSearchOptions {
  workspaceRootPath: string | null
  schema?: WorkspaceFrontmatterSchema | null
}

/**
 * Manages workspace search query, matching options, frontmatter filter conditions and sorting,
 * 200ms IME-safe debounced IPC search, per-file result collapse state, and workspace switch reset.
 */
export function useWorkspaceSearch({
  workspaceRootPath,
  schema = null
}: UseWorkspaceSearchOptions) {
  const wikiApi = useWikiApi()
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchMatchOptions>(DEFAULT_SEARCH_MATCH_OPTIONS)
  const [conditions, setConditions] = useState<FrontmatterFilterCondition[]>([])
  const [sort, setSort] = useState<WorkspaceSearchSortSpec>(DEFAULT_WORKSPACE_SEARCH_SORT)
  const [resultOptions, setResultOptions] = useState<SearchMatchOptions>(
    DEFAULT_SEARCH_MATCH_OPTIONS
  )
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
  const conditionsRef = useRef<FrontmatterFilterCondition[]>(conditions)
  const sortRef = useRef<WorkspaceSearchSortSpec>(sort)
  const workspaceRootPathRef = useRef<string | null>(workspaceRootPath)
  const prevWorkspaceKeyRef = useRef<string | null>(
    workspaceRootPath ? getWorkspacePathKey(workspaceRootPath) : null
  )
  const prevSchemaSigRef = useRef<string>(getSearchSchemaSignature(schema))

  queryRef.current = query
  optionsRef.current = options
  conditionsRef.current = conditions
  sortRef.current = sort
  workspaceRootPathRef.current = workspaceRootPath

  const clearDebounceTimer = useCallback((): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const applyClearedResults = useCallback((nextError: string | null = null): void => {
    setResponse(null)
    setResultOptions(DEFAULT_SEARCH_MATCH_OPTIONS)
    setErrorMessage(nextError)
    setIsSearching(false)
    setCollapsedFileKeys(new Set())
  }, [])

  const resetResults = useCallback((): void => {
    searchSeqRef.current += 1
    applyClearedResults()
  }, [applyClearedResults])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearDebounceTimer()
      searchSeqRef.current += 1
    }
  }, [clearDebounceTimer])

  const executeSearch = useCallback(
    async (
      targetQuery: string,
      targetOptions: SearchMatchOptions,
      targetConditions: FrontmatterFilterCondition[],
      targetSort: WorkspaceSearchSortSpec
    ): Promise<void> => {
      clearDebounceTimer()
      const capturedRoot = workspaceRootPathRef.current
      if (!capturedRoot || (targetQuery.length === 0 && targetConditions.length === 0)) {
        resetResults()
        return
      }

      const searchApi = wikiApi.workspace.search
      if (!searchApi) {
        searchSeqRef.current += 1
        applyClearedResults('워크스페이스 검색 기능을 사용할 수 없습니다.')
        return
      }

      const seq = ++searchSeqRef.current
      setErrorMessage(null)
      setIsSearching(true)

      const includeFrontmatter =
        targetConditions.length > 0 ||
        targetSort.by !== 'path' ||
        targetSort.direction !== 'asc'

      try {
        const nextResponse = await searchApi({
          query: targetQuery,
          options: targetOptions,
          ...(includeFrontmatter
            ? {
                frontmatter: {
                  conditions: targetConditions,
                  sort: targetSort
                }
              }
            : {})
        })
        if (
          !mountedRef.current ||
          seq !== searchSeqRef.current ||
          workspaceRootPathRef.current !== capturedRoot
        ) {
          return
        }
        if (nextResponse.error) {
          applyClearedResults(nextResponse.error)
          return
        }
        setIsSearching(false)
        setResponse(nextResponse)
        setResultOptions(targetOptions)
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
        applyClearedResults(toErrorMessage(error, '워크스페이스 검색에 실패했습니다.'))
      }
    },
    [applyClearedResults, clearDebounceTimer, resetResults, wikiApi]
  )

  useEffect(() => {
    const nextKey = workspaceRootPath ? getWorkspacePathKey(workspaceRootPath) : null
    if (nextKey === prevWorkspaceKeyRef.current) {
      return
    }
    prevWorkspaceKeyRef.current = nextKey
    prevSchemaSigRef.current = getSearchSchemaSignature(schema)
    clearDebounceTimer()
    isComposingRef.current = false
    queryRef.current = ''
    optionsRef.current = DEFAULT_SEARCH_MATCH_OPTIONS
    conditionsRef.current = []
    sortRef.current = DEFAULT_WORKSPACE_SEARCH_SORT
    setQuery('')
    setOptions(DEFAULT_SEARCH_MATCH_OPTIONS)
    setConditions([])
    setSort(DEFAULT_WORKSPACE_SEARCH_SORT)
    resetResults()
  }, [clearDebounceTimer, resetResults, schema, workspaceRootPath])

  useEffect(() => {
    const nextSig = getSearchSchemaSignature(schema)
    if (nextSig === prevSchemaSigRef.current) {
      return
    }
    prevSchemaSigRef.current = nextSig

    const prevConditions = conditionsRef.current
    const prevSort = sortRef.current
    const nextConditions = reconcileFilterConditions(prevConditions, schema)
    const nextSort = reconcileSearchSortSpec(prevSort, schema)

    if (nextConditions.length !== prevConditions.length) {
      conditionsRef.current = nextConditions
      setConditions(nextConditions)
    }
    if (!areSearchSortsEqual(prevSort, nextSort)) {
      sortRef.current = nextSort
      setSort(nextSort)
    }

    if (!workspaceRootPathRef.current || isComposingRef.current) {
      return
    }
    if (queryRef.current.length > 0 || nextConditions.length > 0) {
      void executeSearch(queryRef.current, optionsRef.current, nextConditions, nextSort)
    } else if (prevConditions.length > 0) {
      clearDebounceTimer()
      resetResults()
    }
  }, [clearDebounceTimer, executeSearch, resetResults, schema])

  const scheduleDebouncedSearch = useCallback(
    (nextQuery: string): void => {
      clearDebounceTimer()
      if (!workspaceRootPathRef.current || (nextQuery.length === 0 && conditionsRef.current.length === 0)) {
        resetResults()
        return
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        if (isComposingRef.current) {
          return
        }
        void executeSearch(
          queryRef.current,
          optionsRef.current,
          conditionsRef.current,
          sortRef.current
        )
      }, WORKSPACE_SEARCH_DEBOUNCE_MS)
    },
    [clearDebounceTimer, executeSearch, resetResults]
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
    void executeSearch(
      queryRef.current,
      optionsRef.current,
      conditionsRef.current,
      sortRef.current
    )
  }, [executeSearch])

  const onToggleOption = useCallback(
    (optionKey: keyof SearchMatchOptions): void => {
      const nextOptions: SearchMatchOptions = {
        ...optionsRef.current,
        [optionKey]: !optionsRef.current[optionKey]
      }
      optionsRef.current = nextOptions
      setOptions(nextOptions)
      if (
        !isComposingRef.current &&
        workspaceRootPathRef.current &&
        (queryRef.current.length > 0 || conditionsRef.current.length > 0)
      ) {
        void executeSearch(
          queryRef.current,
          nextOptions,
          conditionsRef.current,
          sortRef.current
        )
      }
    },
    [executeSearch]
  )

  const applyConditionsAndSearch = useCallback(
    (nextConditions: FrontmatterFilterCondition[]): void => {
      conditionsRef.current = nextConditions
      setConditions(nextConditions)
      if (isComposingRef.current || !workspaceRootPathRef.current) {
        return
      }
      if (queryRef.current.length > 0 || nextConditions.length > 0) {
        void executeSearch(
          queryRef.current,
          optionsRef.current,
          nextConditions,
          sortRef.current
        )
      } else {
        clearDebounceTimer()
        resetResults()
      }
    },
    [clearDebounceTimer, executeSearch, resetResults]
  )

  const onAddCondition = useCallback(
    (condition: FrontmatterFilterCondition): void => {
      applyConditionsAndSearch([...conditionsRef.current, condition])
    },
    [applyConditionsAndSearch]
  )

  const onUpdateCondition = useCallback(
    (index: number, nextCondition: FrontmatterFilterCondition): void => {
      const nextConditions = conditionsRef.current.map((item, idx) =>
        idx === index ? nextCondition : item
      )
      applyConditionsAndSearch(nextConditions)
    },
    [applyConditionsAndSearch]
  )

  const onRemoveCondition = useCallback(
    (index: number): void => {
      applyConditionsAndSearch(conditionsRef.current.filter((_, idx) => idx !== index))
    },
    [applyConditionsAndSearch]
  )

  const onClearConditions = useCallback((): void => {
    applyConditionsAndSearch([])
  }, [applyConditionsAndSearch])

  const onUpsertBadgeCondition = useCallback(
    (field: FrontmatterFieldDefinition, value: SummaryBadgeValue): void => {
      const { nextConditions, changed } = upsertBadgeFilterCondition(
        conditionsRef.current,
        field,
        value
      )
      if (changed) {
        applyConditionsAndSearch(nextConditions)
      }
    },
    [applyConditionsAndSearch]
  )

  const onChangeSort = useCallback(
    (nextSort: WorkspaceSearchSortSpec): void => {
      sortRef.current = nextSort
      setSort(nextSort)
      if (
        !isComposingRef.current &&
        workspaceRootPathRef.current &&
        (queryRef.current.length > 0 || conditionsRef.current.length > 0)
      ) {
        void executeSearch(
          queryRef.current,
          optionsRef.current,
          conditionsRef.current,
          nextSort
        )
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
    conditions,
    sort,
    resultOptions,
    response,
    errorMessage,
    isSearching,
    collapsedFileKeys,
    onQueryChange,
    onCompositionStart,
    onCompositionEnd,
    onSubmitSearch,
    onToggleOption,
    onAddCondition,
    onUpdateCondition,
    onRemoveCondition,
    onClearConditions,
    onUpsertBadgeCondition,
    onChangeSort,
    onToggleFileCollapsed
  }
}
