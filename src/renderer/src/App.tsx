import { useEffect, useState } from 'react'
import { AppConfig, DEFAULT_APP_CONFIG, ThemeMode } from '@shared/config'
import { SettingsPanel } from './components/SettingsPanel'

function applyThemeAttribute(theme: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)
  const [configPath, setConfigPath] = useState<string>('')
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [rawConfig, setRawConfig] = useState<string | null>(null)
  const [isLoadingRaw, setIsLoadingRaw] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    applyThemeAttribute(config.theme)
  }, [config.theme])

  useEffect(() => {
    let active = true
    const configApi = window.wikiApi.config

    void Promise.all([configApi.get(), configApi.getConfigPath()])
      .then(([loadedConfig, resolvedPath]) => {
        if (!active) return
        setConfig(loadedConfig)
        setConfigPath(resolvedPath)
      })
      .catch((error: unknown) => {
        if (!active) return
        setErrorMessage(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.')
      })

    const unsubscribe = configApi.onChanged((updatedConfig) => {
      if (!active) return
      setConfig(updatedConfig)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const handleToggleTheme = async (): Promise<void> => {
    const previousTheme = config.theme
    const nextTheme: ThemeMode = previousTheme === 'light' ? 'dark' : 'light'

    setErrorMessage(null)
    setConfig((prev) => ({ ...prev, theme: nextTheme }))

    try {
      const saved = await window.wikiApi.config.update({ theme: nextTheme })
      setConfig(saved)
      if (rawConfig !== null) {
        const refreshedRaw = await window.wikiApi.config.readRaw()
        setRawConfig(refreshedRaw)
      }
    } catch (error: unknown) {
      setConfig((prev) => ({ ...prev, theme: previousTheme }))
      setErrorMessage(error instanceof Error ? error.message : '테마 설정 저장에 실패했습니다.')
    }
  }

  const handleOpenRawConfig = async (): Promise<void> => {
    setIsLoadingRaw(true)
    setErrorMessage(null)
    try {
      const [resolvedPath, raw] = await Promise.all([
        window.wikiApi.config.getConfigPath(),
        window.wikiApi.config.readRaw()
      ])
      setConfigPath(resolvedPath)
      setRawConfig(raw)
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : '설정 파일을 읽지 못했습니다.')
    } finally {
      setIsLoadingRaw(false)
    }
  }

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
            theme={config.theme}
            configPath={configPath}
            rawConfig={rawConfig}
            isLoadingRaw={isLoadingRaw}
            onToggleTheme={() => void handleToggleTheme()}
            onOpenRawConfig={() => void handleOpenRawConfig()}
            onClose={() => setIsSettingsOpen(false)}
          />
        )}
      </main>
    </div>
  )
}
