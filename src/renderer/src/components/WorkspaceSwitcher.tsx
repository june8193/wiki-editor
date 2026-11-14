import { useCallback, useRef, useState } from 'react'
import type { FavoriteWorkspace } from '@shared/config'
import { getWorkspaceDisplayName, isSameWorkspacePath, WorkspaceSummary } from '@shared/workspace'
import { useDismissable } from '../hooks/useDismissable'

interface WorkspaceSwitcherProps {
  workspace: WorkspaceSummary | null
  favoriteWorkspaces: readonly FavoriteWorkspace[]
  recentWorkspaces: readonly string[]
  onSelectFolder: () => void
  onSwitchWorkspace: (path: string) => void
  onRemoveFavorite: (path: string) => void
}

export function WorkspaceSwitcher({
  workspace,
  favoriteWorkspaces,
  recentWorkspaces,
  onSelectFolder,
  onSwitchWorkspace,
  onRemoveFavorite
}: WorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const closeMenu = useCallback(() => setIsOpen(false), [])

  useDismissable(isOpen, containerRef, closeMenu)

  const handleChooseWorkspace = (targetPath: string): void => {
    setIsOpen(false)
    onSwitchWorkspace(targetPath)
  }

  return (
    <div className="workspace-switcher" ref={containerRef}>
      <button type="button" className="btn" onClick={onSelectFolder}>
        폴더 열기
      </button>

      <div className="launcher-dropdown-wrapper">
        <button
          type="button"
          className="btn"
          aria-label="워크스페이스 전환"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((open) => !open)}
        >
          {workspace?.name ?? '워크스페이스 선택'} ▾
        </button>

        {isOpen && (
          <section className="launcher-popover" role="region" aria-label="워크스페이스 목록">
            <div className="launcher-section">
              <div className="launcher-section-title">즐겨찾기 워크스페이스</div>
              {favoriteWorkspaces.length === 0 ? (
                <p className="launcher-empty">등록된 즐겨찾기가 없습니다.</p>
              ) : (
                <ul className="launcher-list">
                  {favoriteWorkspaces.map((fav) => {
                    const active =
                      workspace !== null && isSameWorkspacePath(workspace.rootPath, fav.path)
                    return (
                      <li key={fav.path} className="launcher-item">
                        <button
                          type="button"
                          className={`launcher-item-btn${active ? ' is-active' : ''}`}
                          onClick={() => handleChooseWorkspace(fav.path)}
                        >
                          <span className="launcher-item-name">★ {fav.name}</span>
                          <span className="launcher-item-path">{fav.path}</span>
                        </button>
                        <button
                          type="button"
                          className="launcher-remove-btn"
                          aria-label={`${fav.name} 즐겨찾기 해제`}
                          onClick={() => onRemoveFavorite(fav.path)}
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="launcher-section">
              <div className="launcher-section-title">최근 워크스페이스</div>
              {recentWorkspaces.length === 0 ? (
                <p className="launcher-empty">최근 연 폴더가 없습니다.</p>
              ) : (
                <ul className="launcher-list">
                  {recentWorkspaces.map((recentPath) => {
                    const active =
                      workspace !== null && isSameWorkspacePath(workspace.rootPath, recentPath)
                    return (
                      <li key={recentPath} className="launcher-item">
                        <button
                          type="button"
                          className={`launcher-item-btn${active ? ' is-active' : ''}`}
                          onClick={() => handleChooseWorkspace(recentPath)}
                        >
                          <span className="launcher-item-name">
                            {getWorkspaceDisplayName(recentPath)}
                          </span>
                          <span className="launcher-item-path">{recentPath}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
