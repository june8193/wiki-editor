import { Dirent, FSWatcher, watch as fsWatch } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  getImageExtensionForMimeType,
  isSupportedImageFile,
  toMarkdownRelativeImagePath,
  WorkspaceImageIngestInput,
  WorkspaceImageIngestResult
} from '@shared/assets'
import { WORKSPACE_SEARCH_MAX_FILE_BYTES } from '@shared/search'
import {
  compareWorkspaceEntriesByRelativePath,
  filterTopLevelWorkspaceItems,
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  isMarkdownFileName,
  isNestedOrSameWorkspacePath,
  isSameWorkspacePath,
  normalizeWorkspacePath,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceInfo,
  WorkspaceMovedEntry
} from '@shared/workspace'
import {
  hasBlockedPathSegment,
  isErrnoCode,
  isMissingPathError,
  isPathInsideRoot,
  resolveRealPathWithAncestor,
  WORKSPACE_OUTSIDE_ERROR_MESSAGE,
  WORKSPACE_SYMLINK_ERROR_MESSAGE
} from '../fs/pathSecurity'

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
export type WorkspaceRootChangedListener = (rootPath: string | null) => Promise<void> | void

const INVALID_ENTRY_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/
const INVALID_IMAGE_STEM_CHARS_RE = new RegExp(`${INVALID_ENTRY_NAME_RE.source}+`, 'g')
const WINDOWS_RESERVED_IMAGE_STEM_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const DEFAULT_WATCH_DEBOUNCE_MS = 120
const MAX_IMAGE_COLLISION_INDEX = 10000
const DEFAULT_SEARCH_BINARY_PROBE_BYTES = 8 * 1024

export interface ListWorkspaceFilesOptions {
  filterFileName?: (fileName: string) => boolean
  signal?: AbortSignal
}

export interface ReadTextFileForSearchOptions {
  signal?: AbortSignal
}

function normalizeImageStem(rawStem: string): string {
  const cleaned = rawStem
    .replace(INVALID_IMAGE_STEM_CHARS_RE, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..' || WINDOWS_RESERVED_IMAGE_STEM_RE.test(cleaned)) {
    return 'image'
  }
  return cleaned
}

function formatLocalTimestamp(nowMs?: number): string {
  const candidate = typeof nowMs === 'number' ? new Date(nowMs) : new Date()
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate
  const pad2 = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
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
 * Validates that `rootPath` resolves via `realpath` to an existing directory and returns its canonical path.
 */
export async function resolveValidWorkspaceDirectory(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim()
  if (!trimmed) {
    throw new Error('워크스페이스 경로가 비어 있습니다.')
  }

  const resolvedInput = resolve(trimmed)
  let realRoot: string
  try {
    realRoot = await realpath(resolvedInput)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${resolvedInput}`)
    }
    throw error
  }

  const rootStats = await stat(realRoot)
  if (!rootStats.isDirectory()) {
    throw new Error('선택한 경로는 폴더가 아닙니다.')
  }

  return realRoot
}

/**
 * Resolves `rootPath` via `realpath` when present on disk, falling back to normalized path comparison
 * when absent so non-throwing lookups can still match open workspaces safely.
 */
export async function tryResolveRealWorkspacePath(rootPath: string): Promise<string | null> {
  const trimmed = rootPath.trim()
  if (!trimmed) {
    return null
  }
  const resolvedInput = resolve(trimmed)
  try {
    return await realpath(resolvedInput)
  } catch (error) {
    if (isMissingPathError(error)) {
      return normalizeWorkspacePath(resolvedInput) || null
    }
    throw error
  }
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
  private rootChangedListeners = new Set<WorkspaceRootChangedListener>()

  constructor(options: WorkspaceFsServiceOptions = {}) {
    this.trashItem = options.trashItem
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
  }

  onWorkspaceRootChanged(listener: WorkspaceRootChangedListener): () => void {
    this.rootChangedListeners.add(listener)
    return () => {
      this.rootChangedListeners.delete(listener)
    }
  }

  async openWorkspace(rootPath: string): Promise<WorkspaceInfo> {
    const realRoot = await resolveValidWorkspaceDirectory(rootPath)

    this.unwatch()
    this.workspaceRoot = realRoot
    for (const listener of [...this.rootChangedListeners]) {
      await listener(realRoot)
    }
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

  /**
   * Recursively collects workspace files, excluding ignored system directories, unsafe symlinks,
   * and cyclic directory links.
   */
  async listWorkspaceFiles(options: ListWorkspaceFilesOptions = {}): Promise<WorkspaceEntry[]> {
    const root = this.requireWorkspaceRoot()
    const { filterFileName, signal } = options
    if (signal?.aborted) {
      return []
    }

    const visitedRealDirs = new Set<string>([getWorkspacePathKey(root)])
    const realDirQueue: string[] = [root]
    const symlinkDirQueue: string[] = []
    const entries: WorkspaceEntry[] = []

    const scanDir = async (dirPath: string): Promise<void> => {
      if (signal?.aborted) {
        return
      }
      let dirents: Dirent[]
      try {
        dirents = await readdir(dirPath, { withFileTypes: true })
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
          return
        }
        throw error
      }

      for (const dirent of dirents) {
        if (signal?.aborted) {
          return
        }
        if (IGNORED_ENTRY_NAMES.has(dirent.name)) {
          continue
        }
        const entryPath = join(dirPath, dirent.name)
        const kind = await this.resolveEntryKind(root, dirent, entryPath)
        if (kind === 'file') {
          if (!filterFileName || filterFileName(dirent.name)) {
            entries.push(buildEntry(root, entryPath, 'file'))
          }
          continue
        }
        if (kind === 'directory') {
          if (dirent.isDirectory()) {
            realDirQueue.push(entryPath)
          } else {
            symlinkDirQueue.push(entryPath)
          }
        }
      }
    }

    const drainQueue = async (queue: string[]): Promise<void> => {
      while (queue.length > 0) {
        if (signal?.aborted) {
          return
        }
        const nextDir = queue.shift()!
        if (nextDir !== root) {
          let realDirPath: string
          try {
            realDirPath = await realpath(nextDir)
          } catch {
            continue
          }
          const dirKey = getWorkspacePathKey(realDirPath)
          if (!this.isSafeInternalTarget(root, realDirPath) || visitedRealDirs.has(dirKey)) {
            continue
          }
          visitedRealDirs.add(dirKey)
        }
        await scanDir(nextDir)
      }
    }

    await drainQueue(realDirQueue)
    await drainQueue(symlinkDirQueue)

    if (signal?.aborted) {
      return []
    }
    return entries.sort(compareWorkspaceEntriesByRelativePath)
  }

  /**
   * Recursively collects all workspace Markdown files (`.md` / `.markdown`), excluding ignored
   * system directories, unsafe symlinks, and cyclic directory links.
   */
  listMarkdownFiles(): Promise<WorkspaceEntry[]> {
    return this.listWorkspaceFiles({ filterFileName: isMarkdownFileName })
  }

  async readFile(filePath: string): Promise<string> {
    const resolvedFile = await this.resolveExistingPath(filePath)
    const fileStats = await stat(resolvedFile)
    if (!fileStats.isFile()) {
      throw new Error('파일이 아닙니다.')
    }
    return readFile(resolvedFile, 'utf8')
  }

  /**
   * Safely reads a workspace UTF-8 text file for search, returning `null` if the file exceeds
   * 2MB, contains a null byte in its leading 8KB window, is missing, or is aborted.
   */
  async readTextFileForSearch(
    filePath: string,
    options: ReadTextFileForSearchOptions = {}
  ): Promise<string | null> {
    const signal = options.signal

    const { resolvedReal, exists } = await this.resolveRealWorkspaceTarget(filePath)
    if (signal?.aborted || !exists) {
      return null
    }

    let handle: FileHandle | undefined
    try {
      handle = await open(resolvedReal, 'r')
      if (signal?.aborted) {
        return null
      }

      const fileStats = await handle.stat()
      if (!fileStats.isFile() || fileStats.size > WORKSPACE_SEARCH_MAX_FILE_BYTES) {
        return null
      }
      if (fileStats.size === 0) {
        return ''
      }

      const initialSize = Math.min(fileStats.size, DEFAULT_SEARCH_BINARY_PROBE_BYTES)
      const probeBuffer = Buffer.allocUnsafe(initialSize)
      let probeRead = 0
      while (probeRead < initialSize) {
        if (signal?.aborted) {
          return null
        }
        const { bytesRead } = await handle.read(
          probeBuffer,
          probeRead,
          initialSize - probeRead,
          probeRead
        )
        if (bytesRead === 0) break
        probeRead += bytesRead
      }

      const validProbe = probeBuffer.subarray(0, probeRead)
      if (validProbe.includes(0)) {
        return null
      }
      if (probeRead >= fileStats.size) {
        return validProbe.toString('utf8')
      }

      const chunks: Buffer[] = [validProbe]
      let totalRead = probeRead
      while (totalRead <= WORKSPACE_SEARCH_MAX_FILE_BYTES) {
        if (signal?.aborted) {
          return null
        }
        const chunkSize = Math.min(64 * 1024, WORKSPACE_SEARCH_MAX_FILE_BYTES + 1 - totalRead)
        const chunk = Buffer.allocUnsafe(chunkSize)
        const { bytesRead } = await handle.read(chunk, 0, chunkSize, totalRead)
        if (bytesRead === 0) break
        totalRead += bytesRead
        if (totalRead > WORKSPACE_SEARCH_MAX_FILE_BYTES) {
          return null
        }
        chunks.push(chunk.subarray(0, bytesRead))
      }

      return Buffer.concat(chunks, totalRead).toString('utf8')
    } catch (error) {
      if (isMissingPathError(error) || isErrnoCode(error, 'EISDIR')) {
        return null
      }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
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
      await this.assertPathDoesNotExist(nextPath, validName)
    }

    await rename(logicalTarget, nextPath)

    return buildEntry(root, nextPath, kind)
  }

  private async assertPathDoesNotExist(targetPath: string, entryName: string): Promise<void> {
    const exists = await lstat(targetPath).then(
      () => true,
      (error) => {
        if (isErrnoCode(error, 'ENOENT')) return false
        throw error
      }
    )
    if (exists) {
      throw new Error(`이미 존재하는 이름입니다: ${entryName}`)
    }
  }

  async moveEntries(
    sourcePaths: readonly string[],
    targetDirPath: string
  ): Promise<WorkspaceMovedEntry[]> {
    const root = this.requireWorkspaceRoot()
    const resolvedTargetDir = await this.resolveExistingPath(targetDirPath || '.')
    const targetStats = await stat(resolvedTargetDir)
    if (!targetStats.isDirectory()) {
      throw new Error('이동 대상 경로가 폴더가 아닙니다.')
    }

    if (sourcePaths.length === 0) {
      return []
    }

    const resolvedSources: Array<{
      logicalSource: string
      kind: WorkspaceEntryKind
      isRealDirectory: boolean
    }> = []

    for (const sourcePath of sourcePaths) {
      const logicalSource = await this.resolveExistingLogicalPath(sourcePath)
      if (isSameWorkspacePath(logicalSource, root)) {
        throw new Error('워크스페이스 루트 폴더는 이동할 수 없습니다.')
      }
      const currentStats = await lstat(logicalSource)
      const isSymlink = currentStats.isSymbolicLink()
      const isRealDirectory = !isSymlink && currentStats.isDirectory()
      const kind: WorkspaceEntryKind = isSymlink
        ? (await stat(logicalSource).catch(() => null))?.isDirectory()
          ? 'directory'
          : 'file'
        : isRealDirectory
          ? 'directory'
          : 'file'
      resolvedSources.push({ logicalSource, kind, isRealDirectory })
    }

    const topLevelSources = filterTopLevelWorkspaceItems(
      resolvedSources,
      (item) => item.logicalSource,
      (item) => item.isRealDirectory
    )

    const plannedTargetKeys = new Set<string>()
    const movePlans: Array<{
      logicalSource: string
      nextPath: string
      kind: WorkspaceEntryKind
    }> = []

    for (const source of topLevelSources) {
      if (
        source.isRealDirectory &&
        isNestedOrSameWorkspacePath(resolvedTargetDir, source.logicalSource)
      ) {
        throw new Error('폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.')
      }

      if (isSameWorkspacePath(dirname(source.logicalSource), resolvedTargetDir)) {
        continue
      }

      const entryName = basename(source.logicalSource)
      const nextPath = join(resolvedTargetDir, entryName)
      this.assertLexicalWorkspacePath(root, nextPath)

      const nextKey = getWorkspacePathKey(nextPath)
      if (plannedTargetKeys.has(nextKey)) {
        throw new Error(`이미 존재하는 이름입니다: ${entryName}`)
      }
      plannedTargetKeys.add(nextKey)

      await this.assertPathDoesNotExist(nextPath, entryName)

      movePlans.push({
        logicalSource: source.logicalSource,
        nextPath,
        kind: source.kind
      })
    }

    const movedEntries: WorkspaceMovedEntry[] = []
    for (const plan of movePlans) {
      await rename(plan.logicalSource, plan.nextPath)
      movedEntries.push({
        oldPath: plan.logicalSource,
        entry: buildEntry(root, plan.nextPath, plan.kind)
      })
    }

    return movedEntries
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
      let hasPendingEvent = false
      let pendingRelativePath: string | null = null
      let pendingEventType = 'change'

      this.watcher = fsWatch(root, { recursive: true }, (eventType, filename) => {
        const normalizedRel = filename ? filename.replace(/\\/g, '/') : null
        if (normalizedRel && hasBlockedPathSegment(normalizedRel, IGNORED_ENTRY_NAMES)) {
          return
        }
        if (!hasPendingEvent) {
          hasPendingEvent = true
          pendingRelativePath = normalizedRel
          pendingEventType = eventType
        } else {
          if (pendingEventType !== 'rename' && eventType === 'rename') {
            pendingEventType = 'rename'
          }
          if (pendingRelativePath !== normalizedRel) {
            // Multiple distinct paths changed inside the debounce window -> fall back to full reconcile
            pendingRelativePath = null
          }
        }
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
          hasPendingEvent = false
          pendingRelativePath = null
          pendingEventType = 'change'
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
    for (const listener of [...this.rootChangedListeners]) {
      void listener(null)
    }
    this.rootChangedListeners.clear()
  }

  getWorkspaceRoot(): string | null {
    return this.workspaceRoot
  }

  async resolveAssetPath(
    inputPath: string
  ): Promise<
    { status: 'ok'; resolvedPath: string } | { status: 'forbidden' } | { status: 'not-found' }
  > {
    try {
      const { resolvedReal, exists } = await this.resolveRealWorkspaceTarget(inputPath)
      if (!exists) {
        return { status: 'not-found' }
      }
      return { status: 'ok', resolvedPath: resolvedReal }
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
        return { status: 'not-found' }
      }
      return { status: 'forbidden' }
    }
  }

  /**
   * Ingests a pasted or dropped image into the document's workspace asset folder or references an
   * existing in-workspace image cleanly.
   */
  async ingestImage(input: WorkspaceImageIngestInput): Promise<WorkspaceImageIngestResult> {
    const root = this.requireWorkspaceRoot()
    if (!input.documentPath.trim()) {
      throw new Error('유효한 문서 경로가 필요합니다.')
    }

    const resolvedDocPath = await this.resolveExistingPath(input.documentPath)
    const docStats = await stat(resolvedDocPath)
    if (!docStats.isFile()) {
      throw new Error('문서 경로가 유효하지 않습니다.')
    }
    const docDir = dirname(resolvedDocPath)

    if (input.source.kind === 'clipboard') {
      if (input.source.bytes.byteLength === 0) {
        throw new Error('빈 이미지 데이터는 삽입할 수 없습니다.')
      }
      const extension = getImageExtensionForMimeType(input.source.mimeType)
      if (!extension) {
        throw new Error(`지원하지 않는 이미지 형식입니다: ${input.source.mimeType}`)
      }
      const rawDocStem = basename(resolvedDocPath, extname(resolvedDocPath))
      const stem = `${normalizeImageStem(rawDocStem)}-${formatLocalTimestamp(input.source.now)}`
      return this.saveUniqueAssetToDocAssets(docDir, stem, extension, input.source.bytes)
    }

    if (input.source.kind === 'fileBytes') {
      return this.saveCopiedImageBytes(docDir, input.source.fileName, input.source.bytes)
    }

    return this.ingestFromFilePath(root, docDir, input.source.filePath)
  }

  private async ingestFromFilePath(
    root: string,
    docDir: string,
    rawFilePath: string
  ): Promise<WorkspaceImageIngestResult> {
    if (!rawFilePath.trim() || rawFilePath.includes('\0')) {
      throw new Error('유효하지 않은 이미지 경로입니다.')
    }

    const candidate = isAbsolute(rawFilePath) ? resolve(rawFilePath) : resolve(root, rawFilePath)
    const inWorkspaceLexical = isPathInsideRoot(root, candidate)

    let sourceReal: string
    try {
      sourceReal = await realpath(candidate)
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
        throw new Error(`이미지 파일을 찾을 수 없습니다: ${rawFilePath}`)
      }
      throw error
    }

    const inWorkspaceReal = isPathInsideRoot(root, sourceReal)
    if (inWorkspaceLexical && !inWorkspaceReal) {
      throw new Error('워크스페이스 루트 밖을 가리키는 심볼릭 링크 이미지는 사용할 수 없습니다.')
    }

    const stats = await stat(sourceReal)
    if (!stats.isFile()) {
      throw new Error(`이미지 파일이 아닙니다: ${rawFilePath}`)
    }
    if (stats.size === 0) {
      throw new Error('빈 이미지 파일은 삽입할 수 없습니다.')
    }

    const candidateBase = basename(candidate)
    if (!isSupportedImageFile(candidateBase)) {
      throw new Error(`지원하지 않는 이미지 파일입니다: ${candidateBase}`)
    }

    if (inWorkspaceReal) {
      if (inWorkspaceLexical) {
        this.assertWithinWorkspaceAndAllowed(root, candidate)
      }
      this.assertWithinWorkspaceAndAllowed(root, sourceReal)
      const realBase = basename(sourceReal)
      if (!isSupportedImageFile(realBase)) {
        throw new Error(`지원하지 않는 이미지 파일입니다: ${realBase}`)
      }
      const relPosix = toPosixRelativePath(docDir, sourceReal)
      return {
        markdownPath: toMarkdownRelativeImagePath(relPosix),
        altText: basename(realBase, extname(realBase)),
        savedPath: sourceReal
      }
    }

    const bytes = await readFile(sourceReal)
    return this.saveCopiedImageBytes(docDir, candidateBase, bytes)
  }

  private async saveCopiedImageBytes(
    docDir: string,
    sourceFileName: string,
    bytes: Uint8Array
  ): Promise<WorkspaceImageIngestResult> {
    if (bytes.byteLength === 0) {
      throw new Error('빈 이미지 파일은 삽입할 수 없습니다.')
    }
    const safeName = basename(sourceFileName)
    if (!isSupportedImageFile(safeName)) {
      throw new Error(`지원하지 않는 이미지 파일입니다: ${safeName}`)
    }
    const rawExt = extname(safeName)
    const stem = normalizeImageStem(basename(safeName, rawExt))
    return this.saveUniqueAssetToDocAssets(docDir, stem, rawExt, bytes)
  }

  private async saveUniqueAssetToDocAssets(
    docDir: string,
    stem: string,
    extension: string,
    bytes: Uint8Array
  ): Promise<WorkspaceImageIngestResult> {
    const assetsDir = await this.resolveWritablePath(join(docDir, 'assets'))
    await mkdir(assetsDir, { recursive: true })

    for (let suffixIndex = 0; suffixIndex <= MAX_IMAGE_COLLISION_INDEX; suffixIndex += 1) {
      const targetStem = suffixIndex === 0 ? stem : `${stem}-${suffixIndex}`
      const fileName = `${targetStem}${extension}`
      const targetPath = join(assetsDir, fileName)
      try {
        await writeFile(targetPath, bytes, { flag: 'wx' })
        return {
          markdownPath: toMarkdownRelativeImagePath(`assets/${fileName}`),
          altText: targetStem,
          savedPath: targetPath
        }
      } catch (error) {
        if (isErrnoCode(error, 'EEXIST')) {
          continue
        }
        throw error
      }
    }

    throw new Error(`동일한 이름의 이미지 파일을 저장할 수 없습니다: ${stem}${extension}`)
  }

  private requireWorkspaceRoot(): string {
    if (!this.workspaceRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return this.workspaceRoot
  }

  private assertWithinWorkspaceAndAllowed(root: string, targetPath: string): void {
    if (!isPathInsideRoot(root, targetPath)) {
      throw new Error(WORKSPACE_OUTSIDE_ERROR_MESSAGE)
    }
    if (hasBlockedPathSegment(relative(root, targetPath), IGNORED_ENTRY_NAMES)) {
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

  private resolveRealWithAncestor(
    root: string,
    candidate: string
  ): Promise<{ resolvedReal: string; exists: boolean }> {
    return resolveRealPathWithAncestor(candidate, {
      outsideMessage: WORKSPACE_OUTSIDE_ERROR_MESSAGE,
      danglingSymlinkMessage: WORKSPACE_SYMLINK_ERROR_MESSAGE,
      assertResolved: (resolvedReal) => this.assertWithinWorkspaceAndAllowed(root, resolvedReal)
    })
  }

  private async resolveRealWorkspaceTarget(
    inputPath: string
  ): Promise<{ resolvedReal: string; exists: boolean }> {
    const root = this.requireWorkspaceRoot()
    const candidate = this.assertLexicalWorkspacePath(root, inputPath)
    return this.resolveRealWithAncestor(root, candidate)
  }

  private async resolveExistingPath(inputPath: string): Promise<string> {
    const { resolvedReal, exists } = await this.resolveRealWorkspaceTarget(inputPath)
    if (!exists) {
      throw new Error(`경로를 찾을 수 없습니다: ${inputPath}`)
    }
    return resolvedReal
  }

  private async resolveWritablePath(inputPath: string): Promise<string> {
    const { resolvedReal } = await this.resolveRealWorkspaceTarget(inputPath)
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
      if (!this.isSafeInternalTarget(root, realTarget)) {
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

  private isSafeInternalTarget(root: string, realTarget: string): boolean {
    return (
      isPathInsideRoot(root, realTarget) &&
      !hasBlockedPathSegment(relative(root, realTarget), IGNORED_ENTRY_NAMES)
    )
  }
}
