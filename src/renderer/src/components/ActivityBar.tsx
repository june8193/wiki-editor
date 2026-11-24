import { Files, Folders, GitBranch, GitCompare, Search, type LucideIcon } from 'lucide-react'

export type LeftSidebarView = 'explorer' | 'search' | 'git' | 'compare' | 'workspace'

interface ActivityBarItem {
  id: LeftSidebarView
  label: string
  title?: string
  Icon: LucideIcon
}

const ACTIVITY_BAR_ITEMS: readonly ActivityBarItem[] = [
  { id: 'explorer', label: '탐색기', Icon: Files },
  { id: 'search', label: '검색', title: '검색 (Ctrl+Shift+F)', Icon: Search },
  { id: 'git', label: 'Git', Icon: GitBranch },
  { id: 'compare', label: 'Compare', Icon: GitCompare },
  { id: 'workspace', label: '워크스페이스', Icon: Folders }
]

const MAX_BADGE_COUNT = 99

function formatBadgeText(count: number): string | null {
  if (count <= 0) return null
  return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count)
}

interface ActivityBarProps {
  activeView: LeftSidebarView
  isCollapsed: boolean
  gitChangedCount: number
  onSelectView: (view: LeftSidebarView) => void
}

/**
 * Vertical icon bar on the far left of the app body for switching and toggling left sidebar views.
 */
export function ActivityBar({
  activeView,
  isCollapsed,
  gitChangedCount,
  onSelectView
}: ActivityBarProps) {
  return (
    <nav className="activity-bar" aria-label="액티비티 바">
      {ACTIVITY_BAR_ITEMS.map(({ id, label, title, Icon }) => {
        const isActive = !isCollapsed && activeView === id
        const badgeText = id === 'git' ? formatBadgeText(gitChangedCount) : null
        return (
          <button
            key={id}
            type="button"
            className={`activity-bar-btn${isActive ? ' is-active' : ''}`}
            aria-label={label}
            title={title ?? label}
            aria-pressed={isActive}
            onClick={() => onSelectView(id)}
          >
            <Icon className="activity-bar-icon" size={20} strokeWidth={1.75} aria-hidden="true" />
            {badgeText !== null && <span className="activity-bar-badge">{badgeText}</span>}
          </button>
        )
      })}
    </nav>
  )
}
