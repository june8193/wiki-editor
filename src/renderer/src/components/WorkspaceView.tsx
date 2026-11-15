import type { ReactElement } from 'react'
import { Star } from 'lucide-react'
import { FavoriteWorkspace } from '@shared/config'
import {
  getWorkspaceDisplayName,
  isSameWorkspacePath,
  WorkspaceSummary
} from '@shared/workspace'

interface WorkspaceOption {
  path: string
  label: string
  removeAriaLabel?: string
  onRemove?: () => void
}

interface WorkspaceSectionProps {
  title: string
  emptyMessage: string
  options: readonly WorkspaceOption[]
  activeWorkspaceRootPath: string | null
  onSelect: (path: string) => void
}

function WorkspaceSection({
  title,
  emptyMessage,
  options,
  activeWorkspaceRootPath,
  onSelect
}: WorkspaceSectionProps): ReactElement {
  return (
    <div className="workspace-view-section">
      <div className="workspace-view-section-title">{title}</div>
      {options.length === 0 ? (
        <p className="workspace-view-empty">{emptyMessage}</p>
      ) : (
        <ul className="workspace-view-list">
          {options.map((option) => {
            const active =
              activeWorkspaceRootPath !== null &&
              isSameWorkspacePath(activeWorkspaceRootPath, option.path)
            return (
              <li
                key={option.path}
                className={`workspace-view-item-row${active ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  className={`workspace-view-item${active ? ' is-active' : ''}`}
                  title={option.path}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(option.path)}
                >
                  <span className="workspace-view-item-label">{option.label}</span>
                </button>
                {option.onRemove && (
                  <button
                    type="button"
                    className="workspace-view-remove-btn"
                    aria-label={option.removeAriaLabel}
                    title={option.removeAriaLabel}
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

interface WorkspaceViewProps {
  workspace: WorkspaceSummary | null
  isFavorite: boolean
  favoriteWorkspaces: readonly FavoriteWorkspace[]
  recentWorkspaces: readonly string[]
  onOpenFolder: () => void
  onSwitchWorkspace: (path: string) => void
  onToggleFavorite: () => void
  onRemoveFavorite: (path: string) => void
}

/**
 * 왼쪽 사이드바에 단독 표시되는 워크스페이스 뷰 컴포넌트.
 */
export function WorkspaceView({
  workspace,
  isFavorite,
  favoriteWorkspaces,
  recentWorkspaces,
  onOpenFolder,
  onSwitchWorkspace,
  onToggleFavorite,
  onRemoveFavorite
}: WorkspaceViewProps): ReactElement {
  const activeRootPath = workspace?.rootPath ?? null
  const favoriteLabel = isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'

  const favoriteOptions: WorkspaceOption[] = favoriteWorkspaces.map((fav) => ({
    path: fav.path,
    label: `★ ${fav.name}`,
    removeAriaLabel: `${fav.name} 즐겨찾기 해제`,
    onRemove: () => onRemoveFavorite(fav.path)
  }))

  const recentOptions: WorkspaceOption[] = recentWorkspaces.map((recentPath) => ({
    path: recentPath,
    label: getWorkspaceDisplayName(recentPath)
  }))

  return (
    <section className="workspace-view" aria-label="워크스페이스 뷰">
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <span className="sidebar-title">워크스페이스</span>
        </div>
      </div>

      <div className="workspace-view-body">
        <div className="workspace-view-current">
          {workspace ? (
            <>
              <div className="workspace-view-current-header">
                <span className="workspace-view-current-name">{workspace.name}</span>
                <button
                  type="button"
                  className={`icon-btn${isFavorite ? ' is-favorite' : ''}`}
                  aria-label={favoriteLabel}
                  title={favoriteLabel}
                  aria-pressed={isFavorite}
                  onClick={onToggleFavorite}
                >
                  <Star
                    size={14}
                    strokeWidth={1.75}
                    fill={isFavorite ? 'currentColor' : 'none'}
                    aria-hidden="true"
                  />
                </button>
              </div>
              <div className="workspace-view-current-path" title={workspace.rootPath}>
                {workspace.rootPath}
              </div>
            </>
          ) : (
            <>
              <p className="sidebar-empty-text">열린 워크스페이스 없음</p>
              <p className="workspace-view-guidance">
                폴더를 열거나 아래 목록에서 워크스페이스를 선택하세요.
              </p>
            </>
          )}
          <button
            type="button"
            className="btn btn-sm workspace-view-open-btn"
            onClick={onOpenFolder}
          >
            폴더 열기...
          </button>
        </div>

        <WorkspaceSection
          title="즐겨찾기 워크스페이스"
          emptyMessage="등록된 즐겨찾기가 없습니다."
          options={favoriteOptions}
          activeWorkspaceRootPath={activeRootPath}
          onSelect={onSwitchWorkspace}
        />

        <WorkspaceSection
          title="최근 워크스페이스"
          emptyMessage="최근 연 폴더가 없습니다."
          options={recentOptions}
          activeWorkspaceRootPath={activeRootPath}
          onSelect={onSwitchWorkspace}
        />
      </div>
    </section>
  )
}
