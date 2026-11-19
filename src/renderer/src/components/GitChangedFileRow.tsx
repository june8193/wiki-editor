import {
  File,
  FileCode,
  FileInput,
  FileText,
  Image as ImageIcon,
  Minus,
  Plus,
  Undo2
} from 'lucide-react'
import type { GitChangedFile } from '@shared/git'
import {
  formatGitChangedFileDisplay,
  formatGitFileLabel,
  getGitFileBaseName,
  getGitFileStatusDisplay
} from '../utils/gitFilePresentation'

export type GitFileRowActionKind = 'stage' | 'unstage'

export interface GitChangedFileRowProps {
  file: GitChangedFile
  displayMode: 'list' | 'tree'
  indentDepth?: number
  isBusy?: boolean
  canOpenFile?: boolean
  itemAction?: GitFileRowActionKind
  onSelectFile: (file: GitChangedFile) => void
  onOpenWorkspaceFile?: (repoRelativePath: string) => void
  onDiscardFile?: (file: GitChangedFile) => void
  onItemAction?: (file: GitChangedFile) => void
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i
const DOC_EXT_RE = /\.(?:md|markdown|txt)$/i
const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|json|css|html|yml|yaml)$/i

function GitFileTypeIcon({ filePath }: { filePath: string }) {
  if (IMAGE_EXT_RE.test(filePath)) {
    return <ImageIcon size={13} strokeWidth={1.75} className="git-file-icon" aria-hidden="true" />
  }
  if (DOC_EXT_RE.test(filePath)) {
    return <FileText size={13} strokeWidth={1.75} className="git-file-icon" aria-hidden="true" />
  }
  if (CODE_EXT_RE.test(filePath)) {
    return <FileCode size={13} strokeWidth={1.75} className="git-file-icon" aria-hidden="true" />
  }
  return <File size={13} strokeWidth={1.75} className="git-file-icon" aria-hidden="true" />
}

/**
 * Returns horizontal left-padding indentation for nested tree items at `depth > 0`.
 */
export function getGitTreeIndentStyle(depth: number): { paddingLeft: string } | undefined {
  return depth > 0 ? { paddingLeft: `${4 + depth * 12}px` } : undefined
}

/**
 * Renders a compact 22-24px VS Code-style changed file row with file icon, name,
 * optional dimmed directory path (list mode), hover/focus actions, and rightmost status character.
 */
export function GitChangedFileRow({
  file,
  displayMode,
  indentDepth = 0,
  isBusy = false,
  canOpenFile = false,
  itemAction,
  onSelectFile,
  onOpenWorkspaceFile,
  onDiscardFile,
  onItemAction
}: GitChangedFileRowProps) {
  const statusDisplay = getGitFileStatusDisplay(file.status)
  const listDisplay = displayMode === 'list' ? formatGitChangedFileDisplay(file) : null
  const fileName = listDisplay ? listDisplay.fileName : getGitFileBaseName(file.path)
  const dirPath = listDisplay?.dirPath ?? ''
  const tooltip = listDisplay ? listDisplay.tooltip : formatGitFileLabel(file)
  const indentStyle = getGitTreeIndentStyle(indentDepth)
  const itemActionLabel = itemAction === 'stage' ? 'Stage' : 'Unstage'
  const showActions =
    (canOpenFile && onOpenWorkspaceFile !== undefined) ||
    onDiscardFile !== undefined ||
    (itemAction !== undefined && onItemAction !== undefined)

  return (
    <li className="git-file-item" style={indentStyle}>
      <button
        type="button"
        className="git-file-trigger"
        title={tooltip}
        onClick={() => onSelectFile(file)}
      >
        <GitFileTypeIcon filePath={file.path} />
        <span className={`git-file-name${statusDisplay.strikethrough ? ' is-deleted' : ''}`}>
          {fileName}
        </span>
        {dirPath && <span className="git-file-dir">{dirPath}</span>}
      </button>

      {showActions && (
        <div className="git-file-actions">
          {canOpenFile && onOpenWorkspaceFile && (
            <button
              type="button"
              className="git-hover-icon-btn"
              aria-label={`${file.path} 파일 열기`}
              title="파일 열기"
              disabled={isBusy}
              onClick={() => onOpenWorkspaceFile(file.path)}
            >
              <FileInput size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {onDiscardFile && (
            <button
              type="button"
              className="git-hover-icon-btn"
              aria-label={`${file.path} 변경 사항 롤백`}
              title="변경 사항 롤백"
              disabled={isBusy}
              onClick={() => onDiscardFile(file)}
            >
              <Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {itemAction && onItemAction && (
            <button
              type="button"
              className="git-hover-icon-btn"
              aria-label={`${file.path} ${itemActionLabel}`}
              title={itemActionLabel}
              disabled={isBusy}
              onClick={() => onItemAction(file)}
            >
              {itemAction === 'stage' ? (
                <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Minus size={13} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      )}

      <span
        className={`git-status-letter is-${statusDisplay.modifier}`}
        aria-label={statusDisplay.label}
        title={statusDisplay.label}
      >
        {statusDisplay.displayCode}
      </span>
    </li>
  )
}
