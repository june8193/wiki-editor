import { ThemeMode } from '@shared/config'
import type { TerminalShellProfile } from '@shared/terminal'
import { ModalDialog } from './ModalDialog'

interface SettingsPanelProps {
  theme: ThemeMode
  autoSave: boolean
  defaultTerminalProfile: string | null
  terminalProfiles: readonly TerminalShellProfile[]
  configPath: string
  isDismissDisabled?: boolean
  onToggleTheme: () => void
  onToggleAutoSave: () => void
  onChangeDefaultTerminalProfile: (profileId: string | null) => void
  onOpenConfigEditor: () => void
  onClose: () => void
}

export function SettingsPanel({
  theme,
  autoSave,
  defaultTerminalProfile,
  terminalProfiles,
  configPath,
  isDismissDisabled = false,
  onToggleTheme,
  onToggleAutoSave,
  onChangeDefaultTerminalProfile,
  onOpenConfigEditor,
  onClose
}: SettingsPanelProps) {
  const nextThemeLabel = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'
  const selectedProfileValue =
    defaultTerminalProfile && terminalProfiles.some((profile) => profile.id === defaultTerminalProfile)
      ? defaultTerminalProfile
      : ''

  return (
    <ModalDialog
      backdropClassName="settings-modal-backdrop"
      dialogClassName="settings-modal"
      ariaLabel="전역 설정 패널"
      autoFocusDialog
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
          <h3 className="settings-section-title">터미널</h3>
          <label htmlFor="settings-default-terminal-profile" className="settings-field-label">
            기본 터미널 프로필
          </label>
          <select
            id="settings-default-terminal-profile"
            className="settings-select"
            value={selectedProfileValue}
            onChange={(event) => onChangeDefaultTerminalProfile(event.target.value || null)}
          >
            <option value="">자동 감지 (기본)</option>
            {terminalProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} ({profile.executable})
              </option>
            ))}
          </select>
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
