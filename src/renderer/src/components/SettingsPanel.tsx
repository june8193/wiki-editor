import { useEffect, useRef, useState } from 'react'
import { ThemeMode } from '@shared/config'
import { toErrorMessage } from '../utils/toErrorMessage'

interface SettingsPanelProps {
  theme: ThemeMode
  reloadSignal: number
  configPath: string
  onToggleTheme: () => void
  onReadRawConfig: () => Promise<string>
  onClearError: () => void
  onError: (message: string) => void
  onClose: () => void
}

export function SettingsPanel({
  theme,
  reloadSignal,
  configPath,
  onToggleTheme,
  onReadRawConfig,
  onClearError,
  onError,
  onClose
}: SettingsPanelProps) {
  const [rawConfig, setRawConfig] = useState<string | null>(null)
  const [isLoadingRaw, setIsLoadingRaw] = useState<boolean>(false)
  const [isRawOpen, setIsRawOpen] = useState<boolean>(false)
  const [manualRefreshCount, setManualRefreshCount] = useState<number>(0)
  const readSeqRef = useRef<number>(0)

  const nextThemeLabel = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'

  useEffect(() => {
    if (!isRawOpen) return

    let active = true
    const seq = ++readSeqRef.current
    setIsLoadingRaw(true)

    void onReadRawConfig()
      .then((raw) => {
        if (!active || seq !== readSeqRef.current) return
        setRawConfig(raw)
      })
      .catch((error: unknown) => {
        if (!active || seq !== readSeqRef.current) return
        onError(toErrorMessage(error, '설정 파일을 읽지 못했습니다.'))
      })
      .finally(() => {
        if (!active || seq !== readSeqRef.current) return
        setIsLoadingRaw(false)
      })

    return () => {
      active = false
    }
  }, [reloadSignal, isRawOpen, manualRefreshCount, onError, onReadRawConfig])

  const handleOpenRawConfig = (): void => {
    onClearError()
    setIsRawOpen(true)
    setManualRefreshCount((count) => count + 1)
  }

  return (
    <aside className="settings-panel" aria-label="전역 설정 패널">
      <div className="settings-panel-header">
        <h2>전역 설정</h2>
        <button type="button" className="btn" onClick={onClose}>
          닫기
        </button>
      </div>

      <section className="settings-section">
        <h3 className="settings-section-title">화면 테마</h3>
        <p className="settings-description">현재 테마: {theme === 'light' ? '라이트' : '다크'}</p>
        <button type="button" className="btn" onClick={onToggleTheme}>
          {nextThemeLabel}
        </button>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">전역 설정 파일 (config.json)</h3>
        <code className="config-path-box" data-testid="config-path">
          {configPath || '경로를 불러오는 중...'}
        </code>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleOpenRawConfig}
          disabled={isLoadingRaw}
        >
          {isLoadingRaw ? '불러오는 중...' : '설정 파일 직접 열기'}
        </button>

        {rawConfig !== null && (
          <pre className="config-raw-preview" data-testid="config-raw-preview">
            {rawConfig}
          </pre>
        )}
      </section>
    </aside>
  )
}
