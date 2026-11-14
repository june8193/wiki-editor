import { ThemeMode } from '@shared/config'

interface SettingsPanelProps {
  theme: ThemeMode
  configPath: string
  rawConfig: string | null
  isLoadingRaw: boolean
  onToggleTheme: () => void
  onOpenRawConfig: () => void
  onClose: () => void
}

export function SettingsPanel({
  theme,
  configPath,
  rawConfig,
  isLoadingRaw,
  onToggleTheme,
  onOpenRawConfig,
  onClose
}: SettingsPanelProps) {
  const nextThemeLabel = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'

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
          onClick={onOpenRawConfig}
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
