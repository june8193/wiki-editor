import { useEffect, useRef } from 'react'
import { ThemeMode } from '@shared/config'

interface SettingsPanelProps {
  theme: ThemeMode
  autoSave: boolean
  showHeadingNumbers?: boolean
  configPath: string
  isDismissDisabled?: boolean
  onToggleTheme: () => void
  onToggleAutoSave: () => void
  onToggleShowHeadingNumbers?: () => void
  onOpenConfigEditor: () => void
  onClose: () => void
}

export function SettingsPanel({
  theme,
  autoSave,
  showHeadingNumbers = true,
  configPath,
  isDismissDisabled = false,
  onToggleTheme,
  onToggleAutoSave,
  onToggleShowHeadingNumbers,
  onOpenConfigEditor,
  onClose
}: SettingsPanelProps) {
  const nextThemeLabel = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const isDismissDisabledRef = useRef(isDismissDisabled)
  onCloseRef.current = onClose
  isDismissDisabledRef.current = isDismissDisabled

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isDismissDisabledRef.current) {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <div
      className="modal-backdrop settings-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (!isDismissDisabled && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal-dialog settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="전역 설정 패널"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
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
            <h3 className="settings-section-title">문서 표시</h3>
            <label className="settings-toggle-row">
              <input
                type="checkbox"
                checked={showHeadingNumbers}
                onChange={onToggleShowHeadingNumbers}
              />
              <span>헤딩 자동 넘버링 표시</span>
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
      </div>
    </div>
  )
}
