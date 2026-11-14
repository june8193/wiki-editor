import { useCallback, useRef, useState } from 'react'
import type { FavoriteWorkspace } from '@shared/config'
import { getWorkspaceDisplayName, isSameWorkspacePath, WorkspaceSummary } from '@shared/workspace'
import { useDismissable } from '../hooks/useDismissable'

interface WorkspaceSwitcherOption {
  path: string
  label: string
  removeAriaLabel?: string
  onRemove?: () => void
}

interface WorkspaceSwitcherSectionProps {
  title: string
  emptyMessage: string
  activeWorkspaceRootPath: string | null
  options: readonly WorkspaceSwitcherOption[]
  onSelect: (path: string) => void
}

function WorkspaceSwitcherSection({
  title,
  emptyMessage,
  activeWorkspaceRootPath,
  options,
  onSelect
}: WorkspaceSwitcherSectionProps) {
  return (
    <div className="workspace-switcher-section">
      <div className="workspace-switcher-section-title">{title}</div>
      {options.length === 0 ? (
        <p className="workspace-switcher-empty">{emptyMessage}</p>
      ) : (
        <ul className="workspace-switcher-list">
          {options.map((option) => {
            const active =
              activeWorkspaceRootPath !== null &&
              isSameWorkspacePath(activeWorkspaceRootPath, option.path)
            return (
              <li key={option.path} className="workspace-switcher-item">
                <button
                  type="button"
                  className={`workspace-switcher-item-btn${active ? ' is-active' : ''}`}
                  onClick={() => onSelect(option.path)}
                >
                  <span className="workspace-switcher-item-name">{option.label}</span>
                  <span className="workspace-switcher-item-path">{option.path}</span>
                </button>
                {option.onRemove && option.removeAriaLabel && (
                  <button
                    type="button"
                    className="workspace-switcher-remove-btn"
                    aria-label={option.removeAriaLabel}
                    onClick={option.onRemove}
                  >
                    ×
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

interface WorkspaceSwitcherProps {
  workspace: WorkspaceSummary | null
  favoriteWorkspaces: readonly FavoriteWorkspace[]
  recentWorkspaces: readonly string[]
  onSwitchWorkspace: (path: string) => void
  onRemoveFavorite: (path: string) => void
}

export function WorkspaceSwitcher({
  workspace,
  favoriteWorkspaces,
  recentWorkspaces,
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

  const favoriteOptions: WorkspaceSwitcherOption[] = favoriteWorkspaces.map((fav) => ({
    path: fav.path,
    label: `★ ${fav.name}`,
    removeAriaLabel: `${fav.name} 즐겨찾기 해제`,
    onRemove: () => onRemoveFavorite(fav.path)
  }))

  const recentOptions: WorkspaceSwitcherOption[] = recentWorkspaces.map((recentPath) => ({
    path: recentPath,
    label: getWorkspaceDisplayName(recentPath)
  }))

  return (
    <div className="workspace-switcher" ref={containerRef}>
      <button
        type="button"
        className={`workspace-switcher-trigger${workspace ? '' : ' is-empty'}`}
        title={workspace?.rootPath}
        aria-label="워크스페이스 전환"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="workspace-switcher-label">
          {workspace?.name ?? '워크스페이스 선택'}
        </span>{' '}
        <span className="workspace-switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen && (
        <section
          className="workspace-switcher-popover"
          role="region"
          aria-label="워크스페이스 목록"
        >
          <WorkspaceSwitcherSection
            title="즐겨찾기 워크스페이스"
            emptyMessage="등록된 즐겨찾기가 없습니다."
            activeWorkspaceRootPath={workspace?.rootPath ?? null}
            options={favoriteOptions}
            onSelect={handleChooseWorkspace}
          />
          <WorkspaceSwitcherSection
            title="최근 워크스페이스"
            emptyMessage="최근 연 폴더가 없습니다."
            activeWorkspaceRootPath={workspace?.rootPath ?? null}
            options={recentOptions}
            onSelect={handleChooseWorkspace}
          />
        </section>
      )}
    </div>
  )
}
