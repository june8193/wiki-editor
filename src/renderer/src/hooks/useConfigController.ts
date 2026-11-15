import { useCallback, useEffect, useRef, useState } from 'react'
import { AppConfig, type CustomCommandConfig, DEFAULT_APP_CONFIG, ThemeMode } from '@shared/config'
import { removeRecentWorkspace as removeRecentWorkspaceFromList } from '@shared/workspace'
import { toErrorMessage } from '@shared/errors'
import { useWikiApi } from './useWikiApi'

interface UseConfigControllerOptions {
  onError: (message: string | null, error?: unknown) => void
  onExternalConfigCommitted?: () => void
  onInitialConfigLoaded?: (config: AppConfig) => void
}

/**
 * Manages global AppConfig loading, optimistic mutations, rollback on error, and change broadcasts.
 */
export function useConfigController({
  onError,
  onExternalConfigCommitted,
  onInitialConfigLoaded
}: UseConfigControllerOptions) {
  const wikiApi = useWikiApi()
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)
  const [configPath, setConfigPath] = useState<string>('')

  const latestConfigRef = useRef<AppConfig>(DEFAULT_APP_CONFIG)
  const lastCommittedConfigRef = useRef<AppConfig>(DEFAULT_APP_CONFIG)
  const mutationSeqRef = useRef<number>(0)
  const inFlightUpdatesRef = useRef<number>(0)
  const hasMutationCommitRef = useRef<boolean>(false)
  const mountedRef = useRef<boolean>(true)
  const onErrorRef = useRef(onError)
  const onExternalRef = useRef(onExternalConfigCommitted)
  const onInitialLoadedRef = useRef(onInitialConfigLoaded)

  onErrorRef.current = onError
  onExternalRef.current = onExternalConfigCommitted
  onInitialLoadedRef.current = onInitialConfigLoaded

  const applyUiConfig = useCallback((nextConfig: AppConfig): void => {
    latestConfigRef.current = nextConfig
    setConfig(nextConfig)
  }, [])

  const recordCommittedConfig = useCallback(
    (committed: AppConfig, shouldApplyToUi: boolean): void => {
      lastCommittedConfigRef.current = committed
      if (shouldApplyToUi) {
        applyUiConfig(committed)
      }
    },
    [applyUiConfig]
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme)
  }, [config.theme])

  useEffect(() => {
    mountedRef.current = true
    const configApi = wikiApi.config

    void configApi
      .getConfigPath()
      .then((resolvedPath) => {
        if (mountedRef.current) {
          setConfigPath(resolvedPath)
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          onErrorRef.current(toErrorMessage(error, '설정 경로를 불러오지 못했습니다.'), error)
        }
      })

    void configApi
      .get()
      .then((loadedConfig) => {
        if (!mountedRef.current) return
        recordCommittedConfig(
          loadedConfig,
          inFlightUpdatesRef.current === 0 && !hasMutationCommitRef.current
        )
        onInitialLoadedRef.current?.(loadedConfig)
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return
        onErrorRef.current(toErrorMessage(error, '설정을 불러오지 못했습니다.'), error)
      })

    const unsubscribe = configApi.onChanged((updatedConfig) => {
      if (!mountedRef.current) return
      hasMutationCommitRef.current = true
      recordCommittedConfig(updatedConfig, inFlightUpdatesRef.current === 0)
      onExternalRef.current?.()
    })

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [recordCommittedConfig, wikiApi])

  const runConfigMutation = useCallback(
    async (
      optimisticUpdate: (prev: AppConfig) => AppConfig,
      perform: () => Promise<AppConfig>,
      fallbackError: string
    ): Promise<boolean> => {
      const seq = ++mutationSeqRef.current
      inFlightUpdatesRef.current += 1
      onErrorRef.current(null)

      const optimisticNext = optimisticUpdate(latestConfigRef.current)
      applyUiConfig(optimisticNext)

      try {
        const saved = await perform()
        if (!mountedRef.current) return false
        inFlightUpdatesRef.current -= 1
        hasMutationCommitRef.current = true
        recordCommittedConfig(saved, seq === mutationSeqRef.current)
        return true
      } catch (error: unknown) {
        if (!mountedRef.current) return false
        inFlightUpdatesRef.current -= 1
        if (seq === mutationSeqRef.current) {
          applyUiConfig(lastCommittedConfigRef.current)
          onErrorRef.current(toErrorMessage(error, fallbackError), error)
        }
        return false
      }
    },
    [applyUiConfig, recordCommittedConfig]
  )

  const toggleTheme = useCallback((): void => {
    const nextTheme: ThemeMode = latestConfigRef.current.theme === 'light' ? 'dark' : 'light'
    void runConfigMutation(
      (prev) => ({ ...prev, theme: nextTheme }),
      () => wikiApi.config.update({ theme: nextTheme }),
      '테마 설정 저장에 실패했습니다.'
    )
  }, [runConfigMutation, wikiApi])

  const toggleBooleanConfig = useCallback(
    (key: 'autoSave' | 'showHeadingNumbers', errorMessage: string): void => {
      const nextValue = !latestConfigRef.current[key]
      void runConfigMutation(
        (prev) => ({ ...prev, [key]: nextValue }),
        () => wikiApi.config.update({ [key]: nextValue }),
        errorMessage
      )
    },
    [runConfigMutation, wikiApi]
  )

  const toggleAutoSave = useCallback((): void => {
    toggleBooleanConfig('autoSave', '자동 저장 설정 변경에 실패했습니다.')
  }, [toggleBooleanConfig])

  const toggleShowHeadingNumbers = useCallback((): void => {
    toggleBooleanConfig('showHeadingNumbers', '헤딩 자동 넘버링 설정 변경에 실패했습니다.')
  }, [toggleBooleanConfig])

  const updateCustomCommands = useCallback(
    async (customCommands: CustomCommandConfig[]): Promise<boolean> => {
      const nextCommands = customCommands.map((command) => ({ ...command }))
      return runConfigMutation(
        (prev) => ({ ...prev, customCommands: nextCommands }),
        () => wikiApi.config.update({ customCommands: nextCommands }),
        '커스텀 명령어 저장에 실패했습니다.'
      )
    },
    [runConfigMutation, wikiApi]
  )

  const toggleFavoriteWorkspace = useCallback(
    (workspacePath: string, name: string): void => {
      void runConfigMutation(
        (prev) => prev,
        () => wikiApi.config.toggleFavoriteWorkspace(workspacePath, name),
        '즐겨찾기 설정 변경에 실패했습니다.'
      )
    },
    [runConfigMutation, wikiApi]
  )

  const removeFavoriteWorkspace = useCallback(
    (workspacePath: string): void => {
      void runConfigMutation(
        (prev) => prev,
        () => wikiApi.config.removeFavoriteWorkspace(workspacePath),
        '즐겨찾기 해제에 실패했습니다.'
      )
    },
    [runConfigMutation, wikiApi]
  )

  const removeRecentWorkspace = useCallback(
    (workspacePath: string): void => {
      const nextRecents = removeRecentWorkspaceFromList(
        latestConfigRef.current.recentWorkspaces,
        workspacePath
      )
      void runConfigMutation(
        (prev) => ({ ...prev, recentWorkspaces: nextRecents }),
        () => wikiApi.config.update({ recentWorkspaces: nextRecents }),
        '최근 워크스페이스 목록 갱신에 실패했습니다.'
      )
    },
    [runConfigMutation, wikiApi]
  )

  return {
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleShowHeadingNumbers,
    updateCustomCommands,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    removeRecentWorkspace
  }
}
