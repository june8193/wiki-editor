import { Dirent, FSWatcher, watch as fsWatch } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  getWorkspaceDisplayName,
  isSameWorkspacePath,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceInfo
} from '@shared/workspace'

export const IGNORED_ENTRY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  '.DS_Store',
  'Thumbs.db'
])

export interface WorkspaceFsServiceOptions {
  trashItem?: (targetPath: string) => Promise<void>
  watchDebounceMs?: number
}

export type WorkspaceWatchListener = (event: WorkspaceChangeEvent) => void

const INVALID_ENTRY_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/
const DEFAULT_WATCH_DEBOUNCE_MS = 120

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath)
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${sep}`) &&
      !rel.startsWith('../') &&
      !isAbsolute(rel))
  )
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  const rel = relative(rootPath, targetPath)
  return sep === '\\' ? rel.replace(/\\/g, '/') : rel
}

function buildEntry(root: string, fullPath: string, kind: WorkspaceEntryKind): WorkspaceEntry {
  return {
    name: basename(fullPath),
    path: fullPath,
    relativePath: toPosixRelativePath(root, fullPath),
    kind
  }
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === 'directory' ? -1 : 1
  }
  const baseOrder = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return baseOrder !== 0 ? baseOrder : a.name.localeCompare(b.name)
}

function validateWritableEntryName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || name !== trimmed) {
    throw new Error('유효한 파일 또는 폴더 이름을 입력하세요.')
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('유효하지 않은 이름입니다.')
  }
  if (INVALID_ENTRY_NAME_RE.test(trimmed)) {
    throw new Error('이름에 사용할 수 없는 문자가 포함되어 있습니다.')
  }
  if (trimmed.endsWith('.')) {
    throw new Error('이름은 마침표(.)로 끝날 수 없습니다.')
  }
  if (IGNORED_ENTRY_NAMES.has(trimmed)) {
    throw new Error(`시스템 예약 이름("${trimmed}")은 사용할 수 없습니다.`)
  }
  return trimmed
}

/**
 * Manages asynchronous workspace filesystem traversal, CRUD, path security, and watching.
 */
export class WorkspaceFsService {
  private readonly trashItem?: (targetPath: string) => Promise<void>
  private readonly watchDebounceMs: number

  private workspaceRoot: string | null = null
  private watcher: FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private watchListeners = new Set<WorkspaceWatchListener>()

  constructor(options: WorkspaceFsServiceOptions = {}) {
    this.trashItem = options.trashItem
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
  }

  async openWorkspace(rootPath: string): Promise<WorkspaceInfo> {
    const trimmed = rootPath.trim()
    if (!trimmed) {
      throw new Error('워크스페이스 경로가 비어 있습니다.')
    }

    const resolvedInput = resolve(trimmed)
    let realRoot: string
    try {
      realRoot = await realpath(resolvedInput)
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${resolvedInput}`)
      }
      throw error
    }

    const rootStats = await stat(realRoot)
    if (!rootStats.isDirectory()) {
      throw new Error('선택한 경로는 폴더가 아닙니다.')
    }

    this.unwatch()
    this.workspaceRoot = realRoot
    const entries = await this.readDir()
    return {
      rootPath: realRoot,
      name: getWorkspaceDisplayName(realRoot),
      entries
    }
  }

  async readDir(dirPath = '.'): Promise<WorkspaceEntry[]> {
    const root = this.requireWorkspaceRoot()
    const resolvedDir = await this.resolveExistingPath(dirPath)
    const dirStats = await stat(resolvedDir)
    if (!dirStats.isDirectory()) {
      throw new Error('폴더가 아닙니다.')
    }

    const dirents = await readdir(resolvedDir, { withFileTypes: true })
    const entries: WorkspaceEntry[] = []

    for (const dirent of dirents) {
      if (IGNORED_ENTRY_NAMES.has(dirent.name)) {
        continue
      }
      const entryPath = join(resolvedDir, dirent.name)
      const kind = await this.resolveEntryKind(root, dirent, entryPath)
      if (!kind) {
        continue
      }
      entries.push(buildEntry(root, entryPath, kind))
    }

    return entries.sort(compareEntries)
  }

  async readFile(filePath: string): Promise<string> {
    const resolvedFile = await this.resolveExistingPath(filePath)
    const fileStats = await stat(resolvedFile)
    if (!fileStats.isFile()) {
      throw new Error('파일이 아닙니다.')
    }
    return readFile(resolvedFile, 'utf8')
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolvedTarget = await this.resolveWritablePath(filePath)
    try {
      const targetStats = await stat(resolvedTarget)
      if (targetStats.isDirectory()) {
        throw new Error('폴더에는 파일 내용을 저장할 수 없습니다.')
      }
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) {
        throw error
      }
    }

    const parentStats = await stat(dirname(resolvedTarget))
    if (!parentStats.isDirectory()) {
      throw new Error('상위 폴더가 존재하지 않습니다.')
    }

    await writeFile(resolvedTarget, content, 'utf8')
  }

  async createEntry(
    parentDirPath: string,
    name: string,
    kind: WorkspaceEntryKind,
    initialContent = ''
  ): Promise<WorkspaceEntry> {
    const root = this.requireWorkspaceRoot()
    const validName = validateWritableEntryName(name)

    const resolvedParent = await this.resolveExistingPath(parentDirPath || '.')
    const parentStats = await stat(resolvedParent)
    if (!parentStats.isDirectory()) {
      throw new Error('상위 경로가 폴더가 아닙니다.')
    }

    const targetPath = await this.resolveWritablePath(join(resolvedParent, validName))

    try {
      if (kind === 'directory') {
        await mkdir(targetPath, { recursive: false })
      } else {
        await writeFile(targetPath, initialContent, { encoding: 'utf8', flag: 'wx' })
      }
    } catch (error) {
      if (isErrnoCode(error, 'EEXIST')) {
        throw new Error(`이미 존재하는 파일 또는 폴더입니다: ${validName}`)
      }
      throw error
    }

    return buildEntry(root, targetPath, kind)
  }

  async renameEntry(targetPath: string, newName: string): Promise<WorkspaceEntry> {
    const root = this.requireWorkspaceRoot()
    const validName = validateWritableEntryName(newName)

    const logicalTarget = await this.resolveExistingLogicalPath(targetPath)
    if (isSameWorkspacePath(logicalTarget, root)) {
      throw new Error('워크스페이스 루트 폴더는 이름을 변경할 수 없습니다.')
    }

    const nextPath = join(dirname(logicalTarget), validName)
    this.assertLexicalWorkspacePath(root, nextPath)
    const currentStats = await lstat(logicalTarget)
    const kind: WorkspaceEntryKind = currentStats.isDirectory() ? 'directory' : 'file'

    if (basename(logicalTarget) === validName) {
      return buildEntry(root, logicalTarget, kind)
    }

    const isWindowsCaseOnlyRename =
      process.platform === 'win32' && logicalTarget.toLowerCase() === nextPath.toLowerCase()

    if (!isWindowsCaseOnlyRename) {
      const exists = await lstat(nextPath).then(
        () => true,
        (error) => {
          if (isErrnoCode(error, 'ENOENT')) return false
          throw error
        }
      )
      if (exists) {
        throw new Error(`이미 존재하는 이름입니다: ${validName}`)
      }
    }

    await rename(logicalTarget, nextPath)

    return buildEntry(root, nextPath, kind)
  }

  async deleteEntry(targetPath: string): Promise<void> {
    const root = this.requireWorkspaceRoot()
    const logicalTarget = await this.resolveExistingLogicalPath(targetPath)
    if (isSameWorkspacePath(logicalTarget, root)) {
      throw new Error('워크스페이스 루트 폴더는 삭제할 수 없습니다.')
    }

    await lstat(logicalTarget)
    if (this.trashItem) {
      await this.trashItem(logicalTarget)
      return
    }
    await rm(logicalTarget, { recursive: true, force: false })
  }

  watch(listener: WorkspaceWatchListener): () => void {
    const root = this.requireWorkspaceRoot()
    this.watchListeners.add(listener)

    if (!this.watcher) {
      let pendingRelativePath: string | null = null
      let pendingEventType = 'change'

      this.watcher = fsWatch(root, { recursive: true }, (eventType, filename) => {
        const normalizedRel = filename ? filename.replace(/\\/g, '/') : null
        if (normalizedRel && this.hasIgnoredSegment(normalizedRel)) {
          return
        }
        pendingEventType = eventType
        pendingRelativePath = normalizedRel
        if (this.watchTimer) {
          clearTimeout(this.watchTimer)
        }
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null
          const payload: WorkspaceChangeEvent = {
            rootPath: root,
            eventType: pendingEventType,
            relativePath: pendingRelativePath
          }
          for (const activeListener of this.watchListeners) {
            activeListener(payload)
          }
        }, this.watchDebounceMs)
      })
      this.watcher.on('error', () => {
        this.unwatch()
      })
    }

    return () => {
      this.watchListeners.delete(listener)
      if (this.watchListeners.size === 0) {
        this.unwatch()
      }
    }
  }

  unwatch(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer)
      this.watchTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.watchListeners.clear()
  }

  dispose(): void {
    this.unwatch()
    this.workspaceRoot = null
  }

  private requireWorkspaceRoot(): string {
    if (!this.workspaceRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return this.workspaceRoot
  }

  private hasIgnoredSegment(relativePath: string): boolean {
    if (!relativePath) return false
    return relativePath
      .split(/[\\/]/)
      .filter(Boolean)
      .some((segment) => IGNORED_ENTRY_NAMES.has(segment))
  }

  private assertWithinWorkspaceAndAllowed(root: string, targetPath: string): void {
    if (!isPathInsideRoot(root, targetPath)) {
      throw new Error('워크스페이스 루트 밖의 경로에는 접근할 수 없습니다.')
    }
    if (this.hasIgnoredSegment(relative(root, targetPath))) {
      throw new Error('시스템 폴더 경로에는 접근할 수 없습니다.')
    }
  }

  private assertLexicalWorkspacePath(root: string, inputPath: string): string {
    if (inputPath.includes('\0')) {
      throw new Error('유효하지 않은 경로입니다.')
    }
    const candidate =
      inputPath === '' || inputPath === '.'
        ? root
        : isAbsolute(inputPath)
          ? resolve(inputPath)
          : resolve(root, inputPath)

    this.assertWithinWorkspaceAndAllowed(root, candidate)
    return candidate
  }

  private async rejectDanglingSymlink(cursor: string): Promise<void> {
    let stats
    try {
      stats = await lstat(cursor)
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return
      }
      throw error
    }
    if (stats.isSymbolicLink()) {
      throw new Error('유효하지 않거나 워크스페이스 루트 밖을 가리키는 심볼릭 링크에는 접근할 수 없습니다.')
    }
  }

  private async resolveRealWithAncestor(root: string, candidate: string): Promise<{
    resolvedReal: string
    exists: boolean
  }> {
    const tailSegments: string[] = []
    let cursor = candidate

    while (true) {
      try {
        const realAncestor = await realpath(cursor)
        const resolvedReal =
          tailSegments.length > 0 ? join(realAncestor, ...tailSegments.slice().reverse()) : realAncestor
        this.assertWithinWorkspaceAndAllowed(root, resolvedReal)
        return { resolvedReal, exists: tailSegments.length === 0 }
      } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) {
          throw error
        }
        await this.rejectDanglingSymlink(cursor)
        const parent = dirname(cursor)
        if (parent === cursor) {
          throw new Error('워크스페이스 루트 밖의 경로에는 접근할 수 없습니다.')
        }
        tailSegments.push(basename(cursor))
        cursor = parent
      }
    }
  }

  private async resolveExistingPath(inputPath: string): Promise<string> {
    const root = this.requireWorkspaceRoot()
    const candidate = this.assertLexicalWorkspacePath(root, inputPath)
    const { resolvedReal, exists } = await this.resolveRealWithAncestor(root, candidate)
    if (!exists) {
      throw new Error(`경로를 찾을 수 없습니다: ${inputPath}`)
    }
    return resolvedReal
  }

  private async resolveWritablePath(inputPath: string): Promise<string> {
    const root = this.requireWorkspaceRoot()
    const candidate = this.assertLexicalWorkspacePath(root, inputPath)
    const { resolvedReal } = await this.resolveRealWithAncestor(root, candidate)
    return resolvedReal
  }

  private async resolveExistingLogicalPath(inputPath: string): Promise<string> {
    const root = this.requireWorkspaceRoot()
    const candidate = this.assertLexicalWorkspacePath(root, inputPath)

    let stats
    try {
      stats = await lstat(candidate)
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        throw new Error(`경로를 찾을 수 없습니다: ${inputPath}`)
      }
      throw error
    }

    if (stats.isSymbolicLink()) {
      // For a symlink entry, ensure its parent directory resolves inside the workspace
      const parentCandidate = dirname(candidate)
      if (candidate !== root) {
        await this.resolveRealWithAncestor(root, parentCandidate)
      }
      return candidate
    }

    const { resolvedReal } = await this.resolveRealWithAncestor(root, candidate)
    return resolvedReal
  }

  private async resolveEntryKind(
    root: string,
    dirent: Dirent,
    entryPath: string
  ): Promise<WorkspaceEntryKind | null> {
    if (dirent.isDirectory()) return 'directory'
    if (dirent.isFile()) return 'file'
    if (!dirent.isSymbolicLink()) return null

    try {
      const realTarget = await realpath(entryPath)
      if (!isPathInsideRoot(root, realTarget) || this.hasIgnoredSegment(relative(root, realTarget))) {
        return null
      }
      const targetStats = await stat(realTarget)
      if (targetStats.isDirectory()) return 'directory'
      if (targetStats.isFile()) return 'file'
      return null
    } catch {
      return null
    }
  }
}
