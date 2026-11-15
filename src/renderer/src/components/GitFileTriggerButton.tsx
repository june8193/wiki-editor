import type { GitChangedFile } from '@shared/git'
import { formatGitFileLabel, getGitFileBadgeModifier } from '../utils/gitFilePresentation'

export interface GitFileTriggerButtonProps {
  file: GitChangedFile
  onClick: () => void
}

/**
 * Renders a clickable Git file item button with its status badge and formatted path label.
 */
export function GitFileTriggerButton({ file, onClick }: GitFileTriggerButtonProps) {
  const label = formatGitFileLabel(file)
  return (
    <button type="button" className="git-file-trigger" title={label} onClick={onClick}>
      <span className={`git-badge git-badge--${getGitFileBadgeModifier(file.status)}`}>
        {file.status}
      </span>
      <span className="git-file-path">{label}</span>
    </button>
  )
}
