import { useCallback, useEffect, useRef, useState } from 'react'
import { AppConfig, DEFAULT_APP_CONFIG, ThemeMode } from '@shared/config'
import { SettingsPanel } from './components/SettingsPanel'

function applyThemeAttribute(theme: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)
  const [configPath, setConfigPath] = useState<string>('')
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const latestThemeRef = useRef<ThemeMode>(DEFAULT_APP_CONFIG.theme)
  const mutationSeqRef = useRef<number>(0)
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    applyThemeAttribute(config.theme)
  }, [config.theme])

  useEffect(() => {
    mountedRef.current = true
    const configApi = window.wikiApi.config
    const initialSeq = mutationSeqRef.current

    void Promise.all([configApi.get(), configApi.getConfigPath()])
      .then(([loadedConfig, resolvedPath]) => {
        if (!mountedRef.current) return
        setConfigPath(resolvedPath)
        if (mutationSeqRef.current === initialSeq) {
          latestThemeRef.current = loadedConfig.theme
          setConfig(loadedConfig)
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return
        setErrorMessage(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.')
      })

    const unsubscribe = configApi.onChanged((updatedConfig) => {
      if (!mountedRef.current) return
      mutationSeqRef.current += 1
      latestThemeRef.current = updatedConfig.theme
      setConfig(updatedConfig)
    })

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [])

  const handleToggleTheme = async (): Promise<void> => {
    const seq = ++mutationSeqRef.current
    const previousTheme = latestThemeRef.current
    const nextTheme: ThemeMode = previousTheme === 'light' ? 'dark' : 'light'

    latestThemeRef.current = nextTheme
    setErrorMessage(null)
    setConfig((prev) => ({ ...prev, theme: nextTheme }))

    try {
      const saved = await window.wikiApi.config.update({ theme: nextTheme })
      if (!mountedRef.current || seq !== mutationSeqRef.current) return
      latestThemeRef.current = saved.theme
      setConfig(saved)
    } catch (error: unknown) {
      if (!mountedRef.current || seq !== mutationSeqRef.current) return
      latestThemeRef.current = previousTheme
      setConfig((prev) => ({ ...prev, theme: previousTheme }))
      setErrorMessage(error instanceof Error ? error.message : '테마 설정 저장에 실패했습니다.')
    }
  }

  const handleReadRawConfig = useCallback(async (): Promise<string> => {
    setErrorMessage(null)
    const [resolvedPath, raw] = await Promise.all([
      window.wikiApi.config.getConfigPath(),
      window.wikiApi.config.readRaw()
    ])
    if (mountedRef.current) {
      setConfigPath(resolvedPath)
    }
    return raw
  }, [])

  return (
    <div className="app-shell" data-theme={config.theme}>
      <header className="app-header">
        <h1 className="app-title">Wiki Editor</h1>
        <div className="app-header-actions">
          <button
            type="button"
            className="btn"
            aria-label="테마 전환"
            aria-pressed={config.theme === 'dark'}
            onClick={() => void handleToggleTheme()}
          >
            {config.theme === 'light' ? '다크 모드' : '라이트 모드'}
          </button>
          <button
            type="button"
            className="btn"
            aria-expanded={isSettingsOpen}
            onClick={() => setIsSettingsOpen((open) => !open)}
          >
            설정
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        <section className="workspace-placeholder">
          <p>마크다운 위키 에디터 준비 완료</p>
        </section>

        {isSettingsOpen && (
          <SettingsPanel
            config={config}
            configPath={configPath}
            onToggleTheme={() => void handleToggleTheme()}
            onReadRawConfig={handleReadRawConfig}
            onError={setErrorMessage}
            onClose={() => setIsSettingsOpen(false)}
          />
        )}
      </main>
    </div>
  )
}
