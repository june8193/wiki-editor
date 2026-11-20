import { ThemeMode } from '@shared/config'
import { ModalDialog } from './ModalDialog'

interface SettingsPanelProps {
  theme: ThemeMode
  autoSave: boolean
  configPath: string
  isDismissDisabled?: boolean
  onToggleTheme: () => void
  onToggleAutoSave: () => void
  onOpenConfigEditor: () => void
  onClose: () => void
}

export function SettingsPanel({
  theme,
  autoSave,
  configPath,
  isDismissDisabled = false,
  onToggleTheme,
  onToggleAutoSave,
  onOpenConfigEditor,
  onClose
}: SettingsPanelProps) {
  const nextThemeLabel = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'

  return (
    <ModalDialog
      ariaLabel="전역 설정 패널"
      backdropClassName="settings-modal-backdrop"
      dialogClassName="settings-modal"
      isDismissDisabled={isDismissDisabled}
      onClose={onClose}
    >
      <div className="settings-panel-header">
          <h2>전역 설정</h2>
          <button type="button" className="btn" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="settings-modal-body">
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
              <input type="checkbox" checked={autoSave} onChange={onToggleAutoSave} />
              <span>자동 저장 (Auto-save)</span>
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
        </div>
    </ModalDialog>
  )
}
