import { useCallback, useEffect, useRef, useState } from 'react'
import { AppConfig, DEFAULT_APP_CONFIG, ThemeMode } from '@shared/config'
import { toErrorMessage } from '../utils/toErrorMessage'

interface UseConfigControllerOptions {
  onError: (message: string | null) => void
  onExternalConfigCommitted?: () => void
}

/**
 * Manages global AppConfig loading, optimistic mutations, rollback on error, and change broadcasts.
 */
export function useConfigController({
  onError,
  onExternalConfigCommitted
}: UseConfigControllerOptions) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)
  const [configPath, setConfigPath] = useState<string>('')

  const latestConfigRef = useRef<AppConfig>(DEFAULT_APP_CONFIG)
  const lastCommittedConfigRef = useRef<AppConfig>(DEFAULT_APP_CONFIG)
  const mutationSeqRef = useRef<number>(0)
  const inFlightUpdatesRef = useRef<number>(0)
  const hasMutationCommitRef = useRef<boolean>(false)
  const isSavingRawRef = useRef<boolean>(false)
  const mountedRef = useRef<boolean>(true)
  const onErrorRef = useRef(onError)
  const onExternalRef = useRef(onExternalConfigCommitted)

  onErrorRef.current = onError
  onExternalRef.current = onExternalConfigCommitted

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
    const configApi = window.wikiApi.config

    void configApi
      .getConfigPath()
      .then((resolvedPath) => {
        if (mountedRef.current) {
          setConfigPath(resolvedPath)
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          onErrorRef.current(toErrorMessage(error, '설정 경로를 불러오지 못했습니다.'))
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
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return
        onErrorRef.current(toErrorMessage(error, '설정을 불러오지 못했습니다.'))
      })

    const unsubscribe = configApi.onChanged((updatedConfig) => {
      if (!mountedRef.current) return
      hasMutationCommitRef.current = true
      recordCommittedConfig(updatedConfig, inFlightUpdatesRef.current === 0)
      if (!isSavingRawRef.current) {
        onExternalRef.current?.()
      }
    })

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [recordCommittedConfig])

  const runConfigMutation = useCallback(
    async (
      optimisticUpdate: (prev: AppConfig) => AppConfig,
      perform: () => Promise<AppConfig>,
      fallbackError: string
    ): Promise<void> => {
      const seq = ++mutationSeqRef.current
      inFlightUpdatesRef.current += 1
      onErrorRef.current(null)

      const optimisticNext = optimisticUpdate(latestConfigRef.current)
      applyUiConfig(optimisticNext)

      try {
        const saved = await perform()
        if (!mountedRef.current) return
        inFlightUpdatesRef.current -= 1
        hasMutationCommitRef.current = true
        recordCommittedConfig(saved, seq === mutationSeqRef.current)
      } catch (error: unknown) {
        if (!mountedRef.current) return
        inFlightUpdatesRef.current -= 1
        if (seq === mutationSeqRef.current) {
          applyUiConfig(lastCommittedConfigRef.current)
          onErrorRef.current(toErrorMessage(error, fallbackError))
        }
      }
    },
    [applyUiConfig, recordCommittedConfig]
  )

  const toggleTheme = useCallback((): void => {
    const nextTheme: ThemeMode = latestConfigRef.current.theme === 'light' ? 'dark' : 'light'
    void runConfigMutation(
      (prev) => ({ ...prev, theme: nextTheme }),
      () => window.wikiApi.config.update({ theme: nextTheme }),
      '테마 설정 저장에 실패했습니다.'
    )
  }, [runConfigMutation])

  const toggleAutoSave = useCallback((): void => {
    const nextAutoSave = !latestConfigRef.current.autoSave
    void runConfigMutation(
      (prev) => ({ ...prev, autoSave: nextAutoSave }),
      () => window.wikiApi.config.update({ autoSave: nextAutoSave }),
      '자동 저장 설정 변경에 실패했습니다.'
    )
  }, [runConfigMutation])

  const toggleFavoriteWorkspace = useCallback(
    (workspacePath: string, name: string): void => {
      void runConfigMutation(
        (prev) => prev,
        () => window.wikiApi.config.toggleFavoriteWorkspace(workspacePath, name),
        '즐겨찾기 설정 변경에 실패했습니다.'
      )
    },
    [runConfigMutation]
  )

  const removeFavoriteWorkspace = useCallback(
    (workspacePath: string): void => {
      void runConfigMutation(
        (prev) => prev,
        () => window.wikiApi.config.removeFavoriteWorkspace(workspacePath),
        '즐겨찾기 해제에 실패했습니다.'
      )
    },
    [runConfigMutation]
  )

  const saveRawConfig = useCallback(
    async (rawContent: string): Promise<AppConfig> => {
      isSavingRawRef.current = true
      try {
        const saved = await window.wikiApi.config.saveRaw(rawContent)
        if (mountedRef.current) {
          hasMutationCommitRef.current = true
          recordCommittedConfig(saved, inFlightUpdatesRef.current === 0)
        }
        return saved
      } finally {
        isSavingRawRef.current = false
      }
    },
    [recordCommittedConfig]
  )

  return {
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    saveRawConfig
  }
}
