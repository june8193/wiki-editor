import {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import {
  isSameWorkspacePath,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceSummary
} from '@shared/workspace'
import { useDismissable } from '../hooks/useDismissable'
import type { WorkspaceTreeState } from '../hooks/useWorkspaceTree'

interface InlineCreateState {
  parentDirPath: string
  kind: WorkspaceEntryKind
}

interface ContextMenuState {
  entry: WorkspaceEntry
  x: number
  y: number
}

interface InlineTreeInputProps {
  ariaLabel: string
  placeholder?: string
  value: string
  onChange: (nextValue: string) => void
  onSubmit: () => void
  onCancel: () => void
}

function InlineTreeInput({
  ariaLabel,
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel
}: InlineTreeInputProps) {
  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="tree-inline-form"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="text"
        className="tree-inline-input"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }}
      />
    </form>
  )
}

function treeIndentStyle(depth: number): CSSProperties {
  return { paddingLeft: `${12 + depth * 14}px` }
}

interface FolderTreeSidebarProps {
  workspace: WorkspaceSummary | null
  isFavorite: boolean
  workspaceSwitcher: ReactNode
  tree: WorkspaceTreeState
  activeFilePath: string | null
  onToggleFavorite: () => void
  onSelectPath: (path: string | null) => void
  onToggleDirectory: (entry: WorkspaceEntry) => void
  onEnsureExpanded: (dirPath: string) => Promise<void>
  onResolveCreateParentDir: () => string | null
  onOpenFile: (entry: WorkspaceEntry) => void
  onRefreshTree: () => void
  onCreateEntry: (parentDirPath: string, name: string, kind: WorkspaceEntryKind) => Promise<void>
  onRenameEntry: (targetPath: string, newName: string) => Promise<void>
  onRequestDelete: (entry: WorkspaceEntry) => void
}

export function FolderTreeSidebar({
  workspace,
  isFavorite,
  workspaceSwitcher,
  tree,
  activeFilePath,
  onToggleFavorite,
  onSelectPath,
  onToggleDirectory,
  onEnsureExpanded,
  onResolveCreateParentDir,
  onOpenFile,
  onRefreshTree,
  onCreateEntry,
  onRenameEntry,
  onRequestDelete
}: FolderTreeSidebarProps) {
  const [inlineCreate, setInlineCreate] = useState<InlineCreateState | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [renamingEntry, setRenamingEntry] = useState<WorkspaceEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  useDismissable(contextMenu !== null, menuRef, closeContextMenu)

  // Reset transient editing states whenever active workspace changes
  useEffect(() => {
    setInlineCreate(null)
    setCreateValue('')
    setRenamingEntry(null)
    setRenameValue('')
    setContextMenu(null)
  }, [workspace?.rootPath])

  const cancelCreate = (): void => {
    setInlineCreate(null)
    setCreateValue('')
  }

  const beginCreate = async (kind: WorkspaceEntryKind, explicitParent?: string): Promise<void> => {
    if (!workspace) return
    setContextMenu(null)
    setRenamingEntry(null)
    const targetParent = explicitParent ?? onResolveCreateParentDir() ?? workspace.rootPath
    if (targetParent !== workspace.rootPath) {
      await onEnsureExpanded(targetParent)
    }
    setCreateValue('')
    setInlineCreate({ parentDirPath: targetParent, kind })
  }

  const beginRename = (entry: WorkspaceEntry): void => {
    setContextMenu(null)
    setInlineCreate(null)
    setRenamingEntry(entry)
    setRenameValue(entry.name)
  }

  const submitCreate = async (): Promise<void> => {
    if (!inlineCreate) return
    const trimmed = createValue.trim()
    const currentCreate = inlineCreate
    cancelCreate()
    if (!trimmed) return
    await onCreateEntry(currentCreate.parentDirPath, trimmed, currentCreate.kind)
  }

  const submitRename = async (): Promise<void> => {
    if (!renamingEntry) return
    const trimmed = renameValue.trim()
    const target = renamingEntry
    setRenamingEntry(null)
    if (!trimmed || trimmed === target.name) return
    await onRenameEntry(target.path, trimmed)
  }

  const handleTreeItemKeyDown = (
    event: ReactKeyboardEvent<HTMLLIElement>,
    entry: WorkspaceEntry
  ): void => {
    const targetTag = (event.target as HTMLElement | null)?.tagName
    if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || renamingEntry?.path === entry.path) {
      return
    }

    if (event.key === 'F2') {
      event.preventDefault()
      event.stopPropagation()
      beginRename(entry)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      event.stopPropagation()
      onRequestDelete(entry)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (entry.kind === 'directory') {
        onToggleDirectory(entry)
      } else {
        onOpenFile(entry)
      }
    }
  }

  const handleRowContextMenu = (
    event: ReactMouseEvent<HTMLLIElement>,
    entry: WorkspaceEntry
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    onSelectPath(entry.path)
    setContextMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const renderInlineCreateRow = (depth: number) => {
    if (!inlineCreate) return null
    return (
      <li className="tree-inline-form-row" style={treeIndentStyle(depth)}>
        <InlineTreeInput
          ariaLabel={inlineCreate.kind === 'file' ? '새 파일 이름' : '새 폴더 이름'}
          placeholder={inlineCreate.kind === 'file' ? '예: note.md' : '새 폴더 이름'}
          value={createValue}
          onChange={setCreateValue}
          onSubmit={() => void submitCreate()}
          onCancel={cancelCreate}
        />
      </li>
    )
  }

  const renderEntries = (entries: readonly WorkspaceEntry[], depth: number) =>
    entries.map((entry) => {
      const isDir = entry.kind === 'directory'
      const isExpanded = isDir && tree.expandedDirs.has(entry.path)
      const isLoading = isDir && tree.loadingDirs.has(entry.path)
      const isSelected = tree.selectedPath === entry.path
      const isActiveFile =
        !isDir && activeFilePath !== null && isSameWorkspacePath(activeFilePath, entry.path)
      const isRenaming = renamingEntry?.path === entry.path
      const childEntries = tree.childrenByDir[entry.path] ?? []
      const showCreateInside = inlineCreate?.parentDirPath === entry.path

      return (
        <li
          key={entry.path}
          role="treeitem"
          aria-label={entry.name}
          aria-expanded={isDir ? isExpanded : undefined}
          aria-selected={isSelected}
          tabIndex={0}
          className="tree-item-wrapper"
          onKeyDown={(event) => handleTreeItemKeyDown(event, entry)}
          onContextMenu={(event) => handleRowContextMenu(event, entry)}
        >
          <div
            className={`tree-row${isSelected ? ' is-selected' : ''}${isActiveFile ? ' is-active-file' : ''}`}
            style={treeIndentStyle(depth)}
            onClick={(event) => {
              event.stopPropagation()
              onSelectPath(entry.path)
              if (isDir) {
                onToggleDirectory(entry)
              } else {
                onOpenFile(entry)
              }
            }}
          >
            <span className="tree-icon" aria-hidden="true">
              {isDir ? (isExpanded ? '▼' : '▶') : '📄'}
            </span>

            {isRenaming ? (
              <InlineTreeInput
                ariaLabel="새 이름 입력"
                value={renameValue}
                onChange={setRenameValue}
                onSubmit={() => void submitRename()}
                onCancel={() => setRenamingEntry(null)}
              />
            ) : (
              <span className="tree-label">{entry.name}</span>
            )}
          </div>

          {isDir && isExpanded && (
            <ul role="group" className="tree-group">
              {showCreateInside && renderInlineCreateRow(depth + 1)}
              {isLoading && childEntries.length === 0 ? (
                <li className="tree-status-row" style={treeIndentStyle(depth + 1)}>
                  불러오는 중...
                </li>
              ) : (
                renderEntries(childEntries, depth + 1)
              )}
            </ul>
          )}
        </li>
      )
    })

  return (
    <section className="workspace-sidebar" aria-label="워크스페이스 탐색기">
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          {workspaceSwitcher}
          {workspace && (
            <button
              type="button"
              className={`icon-btn${isFavorite ? ' is-favorite' : ''}`}
              aria-label={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
              aria-pressed={isFavorite}
              onClick={onToggleFavorite}
            >
              {isFavorite ? '★' : '☆'}
            </button>
          )}
        </div>
        {workspace && (
          <div className="sidebar-actions">
            <button
              type="button"
              className="btn btn-sm"
              aria-label="새 파일"
              onClick={() => void beginCreate('file')}
            >
              + 파일
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="새 폴더"
              onClick={() => void beginCreate('directory')}
            >
              + 폴더
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="트리 새로고침"
              onClick={onRefreshTree}
            >
              새로고침
            </button>
          </div>
        )}
      </div>

      {!workspace ? (
        <div className="sidebar-empty">
          <p className="sidebar-empty-text">열린 워크스페이스 없음</p>
          <p className="workspace-placeholder-hint">상단의 &apos;폴더 열기&apos;로 시작하세요.</p>
        </div>
      ) : (
        <ul role="tree" className="folder-tree" onClick={() => onSelectPath(null)}>
          {inlineCreate?.parentDirPath === workspace.rootPath && renderInlineCreateRow(0)}
          {tree.rootEntries.length === 0 && !inlineCreate ? (
            <li className="tree-status-row">빈 폴더입니다.</li>
          ) : (
            renderEntries(tree.rootEntries, 0)
          )}
        </ul>
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          role="menu"
          className="tree-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {contextMenu.entry.kind === 'directory' ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="context-menu-item"
                onClick={() => void beginCreate('file', contextMenu.entry.path)}
              >
                새 파일
              </button>
              <button
                type="button"
                role="menuitem"
                className="context-menu-item"
                onClick={() => void beginCreate('directory', contextMenu.entry.path)}
              >
                새 폴더
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              onClick={() => {
                const target = contextMenu.entry
                setContextMenu(null)
                onOpenFile(target)
              }}
            >
              열기
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => beginRename(contextMenu.entry)}
          >
            이름 변경 (F2)
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item is-danger"
            onClick={() => {
              const target = contextMenu.entry
              setContextMenu(null)
              onRequestDelete(target)
            }}
          >
            삭제
          </button>
        </div>
      )}
    </section>
  )
}
