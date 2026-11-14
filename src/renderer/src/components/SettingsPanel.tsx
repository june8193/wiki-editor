import { useEffect, useState } from 'react'
import { ThemeMode } from '@shared/config'

interface SettingsPanelProps {
  theme: ThemeMode
  autoSave: boolean
  autoSaveDelayMs: number
  configPath: string
  onToggleTheme: () => void
  onToggleAutoSave: () => void
  onUpdateAutoSaveDelay: (delayMs: number) => void
  onOpenConfigEditor: () => void
  onClose: () => void
}

export function SettingsPanel({
  theme,
  autoSave,
  autoSaveDelayMs,
  configPath,
  onToggleTheme,
  onToggleAutoSave,
  onUpdateAutoSaveDelay,
  onOpenConfigEditor,
  onClose
}: SettingsPanelProps) {
  const [delayDraft, setDelayDraft] = useState<string>(String(autoSaveDelayMs))

  useEffect(() => {
    setDelayDraft(String(autoSaveDelayMs))
  }, [autoSaveDelayMs])

  const commitDelayDraft = (): void => {
    const parsed = Number(delayDraft)
    if (Number.isFinite(parsed) && parsed >= 100) {
      const rounded = Math.round(parsed)
      setDelayDraft(String(rounded))
      if (rounded !== autoSaveDelayMs) {
        onUpdateAutoSaveDelay(rounded)
      }
    } else {
      setDelayDraft(String(autoSaveDelayMs))
    }
  }

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
        <h3 className="settings-section-title">문서 저장</h3>
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={onToggleAutoSave}
          />
          <span>자동 저장 (Auto-save)</span>
        </label>
        <label className="settings-delay-row">
          <span className="settings-description">자동 저장 지연 시간 (ms)</span>
          <input
            type="number"
            min={100}
            step={100}
            className="settings-number-input"
            aria-label="자동 저장 지연 시간"
            value={delayDraft}
            onChange={(event) => setDelayDraft(event.target.value)}
            onBlur={commitDelayDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitDelayDraft()
              }
            }}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">전역 설정 파일 (config.json)</h3>
        <code className="config-path-box" data-testid="config-path">
          {configPath || '경로를 불러오는 중...'}
        </code>
        <button type="button" className="btn btn-primary" onClick={onOpenConfigEditor}>
          설정 파일 직접 열기
        </button>
      </section>
    </aside>
  )
}
