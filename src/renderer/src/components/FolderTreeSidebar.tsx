import {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  getWorkspacePathKey,
  isSameWorkspacePath,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceSummary
} from '@shared/workspace'
import {
  buildTreeEntryMap,
  collectVisibleTreeEntries,
  resolveSelectedTreeEntries
} from '../utils/folderTree'
import { useDismissable } from '../hooks/useDismissable'
import { useFolderTreeDnd } from '../hooks/useFolderTreeDnd'
import type { WorkspaceTreeState } from '../hooks/useWorkspaceTree'

interface InlineCreateState {
  parentDirPath: string
  kind: WorkspaceEntryKind
}

interface ContextMenuState {
  entry: WorkspaceEntry
  targets: readonly WorkspaceEntry[]
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
      onDragStart={(event) => event.stopPropagation()}
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

export type EntryPathCopyMode = 'relative' | 'absolute'

interface FolderTreeSidebarProps {
  workspace: WorkspaceSummary | null
  tree: WorkspaceTreeState
  activeFilePath: string | null
  onSelectPath: (path: string | null) => void
  onToggleSelectPath: (path: string) => void
  onSelectPathRange: (targetPath: string, visibleEntries: readonly WorkspaceEntry[]) => void
  onToggleDirectory: (entry: WorkspaceEntry) => void
  onEnsureExpanded: (dirPath: string) => Promise<void>
  onResolveCreateParentDir: () => string | null
  onOpenFile: (entry: WorkspaceEntry) => void
  onRefreshTree: () => void
  onCreateEntry: (parentDirPath: string, name: string, kind: WorkspaceEntryKind) => Promise<void>
  onRenameEntry: (targetPath: string, newName: string) => Promise<void>
  onMoveEntries: (sourcePaths: readonly string[], targetDirPath: string) => Promise<void>
  onRequestDelete: (entries: readonly WorkspaceEntry[]) => void
  onCopyEntryPath: (entries: readonly WorkspaceEntry[], mode: EntryPathCopyMode) => void
  onDragStartWorkspaceImages?: (filePaths: readonly string[]) => void
  onDragEndWorkspaceImage?: () => void
}

export function FolderTreeSidebar({
  workspace,
  tree,
  activeFilePath,
  onSelectPath,
  onToggleSelectPath,
  onSelectPathRange,
  onToggleDirectory,
  onEnsureExpanded,
  onResolveCreateParentDir,
  onOpenFile,
  onRefreshTree,
  onCreateEntry,
  onRenameEntry,
  onMoveEntries,
  onRequestDelete,
  onCopyEntryPath,
  onDragStartWorkspaceImages,
  onDragEndWorkspaceImage
}: FolderTreeSidebarProps) {
  const [inlineCreate, setInlineCreate] = useState<InlineCreateState | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [renamingEntry, setRenamingEntry] = useState<WorkspaceEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  useDismissable(contextMenu !== null, menuRef, closeContextMenu)

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
    const clampedX = Math.min(Math.max(margin, contextMenu.x), maxX)
    const clampedY = Math.min(Math.max(margin, contextMenu.y), maxY)

    if (clampedX !== contextMenu.x || clampedY !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: clampedX, y: clampedY } : null))
    }
  }, [contextMenu])

  const visibleEntries = useMemo(
    () => collectVisibleTreeEntries(tree.rootEntries, tree),
    [tree]
  )

  const entryByKey = useMemo(() => buildTreeEntryMap(tree), [tree])

  const selectedPathKeys = useMemo(
    () => new Set(tree.selectedPaths.map((path) => getWorkspacePathKey(path))),
    [tree.selectedPaths]
  )

  const selectedEntries = useMemo(
    () =>
      resolveSelectedTreeEntries(visibleEntries, entryByKey, tree.selectedPaths, selectedPathKeys),
    [entryByKey, selectedPathKeys, tree.selectedPaths, visibleEntries]
  )

  const isPathSelected = useCallback(
    (entryPath: string): boolean => selectedPathKeys.has(getWorkspacePathKey(entryPath)),
    [selectedPathKeys]
  )

  const resolveEntryActionTargets = (entry: WorkspaceEntry): readonly WorkspaceEntry[] =>
    isPathSelected(entry.path) && selectedEntries.length > 0 ? selectedEntries : [entry]

  const {
    dropTargetDirPath,
    handleEntryDragStart,
    handleTreeDragOver,
    handleTreeDrop,
    handleTreeDragLeave,
    handleTreeDragEnd
  } = useFolderTreeDnd({
    workspace,
    expandedDirs: tree.expandedDirs,
    entryByKey,
    isPathSelected,
    resolveActionTargets: resolveEntryActionTargets,
    onSelectPath,
    onEnsureExpanded,
    onMoveEntries,
    onDragStartWorkspaceImages,
    onDragEndWorkspaceImage
  })

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
      if (selectedEntries.length > 1) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      beginRename(entry)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      event.stopPropagation()
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry]
      onRequestDelete(targets)
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
    const targets = resolveEntryActionTargets(entry)
    if (!isPathSelected(entry.path)) {
      onSelectPath(entry.path)
    }
    setContextMenu({ entry, targets, x: event.clientX, y: event.clientY })
  }

  const handleCopyPath = (mode: EntryPathCopyMode): void => {
    if (!contextMenu) return
    const targets = contextMenu.targets
    setContextMenu(null)
    onCopyEntryPath(targets, mode)
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
      const isSelected = isPathSelected(entry.path)
      const isActiveFile =
        !isDir && activeFilePath !== null && isSameWorkspacePath(activeFilePath, entry.path)
      const isRenaming = renamingEntry?.path === entry.path
      const isDropTarget =
        isDir &&
        dropTargetDirPath !== null &&
        isSameWorkspacePath(dropTargetDirPath, entry.path)
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
          draggable={!isRenaming}
          onDragStart={(event) => handleEntryDragStart(event, entry, isRenaming)}
          onDragOver={(event) => handleTreeDragOver(event, entry)}
          onDrop={(event) => handleTreeDrop(event, entry)}
          onDragEnd={handleTreeDragEnd}
          onKeyDown={(event) => handleTreeItemKeyDown(event, entry)}
          onContextMenu={(event) => handleRowContextMenu(event, entry)}
        >
          <div
            className={`tree-row${isSelected ? ' is-selected' : ''}${isActiveFile ? ' is-active-file' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
            data-drop-target={isDropTarget ? 'true' : undefined}
            style={treeIndentStyle(depth)}
            onClick={(event) => {
              event.stopPropagation()
              if (event.shiftKey) {
                onSelectPathRange(entry.path, visibleEntries)
                return
              }
              if (event.ctrlKey || event.metaKey) {
                onToggleSelectPath(entry.path)
                return
              }
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

  const isRootDropTarget = Boolean(
    workspace &&
      dropTargetDirPath !== null &&
      isSameWorkspacePath(dropTargetDirPath, workspace.rootPath)
  )
  const isMultiContextMenu = Boolean(contextMenu && contextMenu.targets.length > 1)

  return (
    <section className="workspace-sidebar" aria-label="워크스페이스 탐색기">
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <span className="sidebar-title" title={workspace?.rootPath}>
            {workspace ? workspace.name : '탐색기'}
          </span>
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
          <p className="workspace-placeholder-hint">
            File 메뉴의 &apos;폴더 열기&apos; 또는 워크스페이스 뷰에서 폴더를 열어 시작하세요.
          </p>
        </div>
      ) : (
        <ul
          role="tree"
          aria-multiselectable="true"
          className={`folder-tree${isRootDropTarget ? ' is-root-drop-target' : ''}`}
          data-drop-target={isRootDropTarget ? 'root' : undefined}
          onClick={() => onSelectPath(null)}
          onDragOver={(event) => handleTreeDragOver(event, null)}
          onDrop={(event) => handleTreeDrop(event, null)}
          onDragLeave={handleTreeDragLeave}
        >
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
                disabled={isMultiContextMenu}
                onClick={() => void beginCreate('file', contextMenu.entry.path)}
              >
                새 파일
              </button>
              <button
                type="button"
                role="menuitem"
                className="context-menu-item"
                disabled={isMultiContextMenu}
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
              disabled={isMultiContextMenu}
              onClick={() => {
                const target = contextMenu.entry
                setContextMenu(null)
                onOpenFile(target)
              }}
            >
              열기
            </button>
          )}
          <div role="separator" className="context-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => handleCopyPath('relative')}
          >
            상대 경로 복사
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => handleCopyPath('absolute')}
          >
            절대 경로 복사
          </button>
          <div role="separator" className="context-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={isMultiContextMenu}
            onClick={() => beginRename(contextMenu.entry)}
          >
            이름 변경 (F2)
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item is-danger"
            onClick={() => {
              const targets = contextMenu.targets
              setContextMenu(null)
              onRequestDelete(targets)
            }}
          >
            삭제
          </button>
        </div>
      )}
    </section>
  )
}
