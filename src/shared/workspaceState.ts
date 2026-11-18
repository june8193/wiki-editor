import { isPlainRecord } from './config'
import {
  type CursorPosition,
  DEFAULT_SPLIT_RATIO,
  type EditorMode,
  normalizeSplitRatio,
  type PaneId,
  type SplitMode
} from './window'
import {
  getWorkspacePathKey,
  isSameWorkspacePath,
  resolveNormalizedWorkspacePath,
  resolveWorkspaceChildPath
} from './workspace'

export const WORKSPACE_STATE_VERSION = 1
export const DEFAULT_MAX_PERSISTED_WORKSPACES = 30
const EPOCH_ISO = new Date(0).toISOString()

export interface PersistedWorkspaceTabState {
  path: string
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
  splitPreviewRatio: number
}

export interface PersistedWorkspacePaneState {
  tabs: PersistedWorkspaceTabState[]
  activeTabPath: string | null
}

export interface PersistedWorkspacePaneLayout {
  splitMode: SplitMode
  splitRatio: number
  activePaneId: PaneId
  panes: Record<PaneId, PersistedWorkspacePaneState>
}

export interface PersistedWorkspaceState {
  rootPath: string
  updatedAt: string // ISO-8601
  expandedDirs: string[]
  layout: PersistedWorkspacePaneLayout
}

export interface WorkspaceStateDocument {
  version: 1
  workspaces: Record<string, PersistedWorkspaceState>
}

export interface WorkspaceStateUpdate {
  expandedDirs?: readonly string[]
  layout?: PersistedWorkspacePaneLayout
}

export interface NormalizeWorkspaceStateOptions {
  maxWorkspaces?: number
}

export function createEmptyPersistedWorkspaceLayout(): PersistedWorkspacePaneLayout {
  return {
    splitMode: 'single',
    splitRatio: DEFAULT_SPLIT_RATIO,
    activePaneId: 'primary',
    panes: {
      primary: { tabs: [], activeTabPath: null },
      secondary: { tabs: [], activeTabPath: null }
    }
  }
}

export function createDefaultWorkspaceStateDocument(): WorkspaceStateDocument {
  return {
    version: WORKSPACE_STATE_VERSION,
    workspaces: {}
  }
}

/**
 * Checks whether a parsed JSON value violates top-level WorkspaceStateDocument structure.
 */
export function getCorruptWorkspaceStateRootReason(parsed: unknown): string | null {
  if (!isPlainRecord(parsed)) {
    return 'non-object'
  }
  if (
    'version' in parsed &&
    parsed.version !== undefined &&
    parsed.version !== WORKSPACE_STATE_VERSION
  ) {
    return 'unsupported-version'
  }
  if (
    'workspaces' in parsed &&
    parsed.workspaces !== undefined &&
    !isPlainRecord(parsed.workspaces)
  ) {
    return 'non-object-workspaces'
  }
  return null
}

function cloneTabState(tab: PersistedWorkspaceTabState): PersistedWorkspaceTabState {
  return {
    ...tab,
    cursor: { ...tab.cursor }
  }
}

function clonePaneState(pane: PersistedWorkspacePaneState): PersistedWorkspacePaneState {
  return {
    tabs: pane.tabs.map(cloneTabState),
    activeTabPath: pane.activeTabPath
  }
}

export function clonePersistedWorkspaceState(
  state: PersistedWorkspaceState
): PersistedWorkspaceState {
  return {
    rootPath: state.rootPath,
    updatedAt: state.updatedAt,
    expandedDirs: [...state.expandedDirs],
    layout: {
      splitMode: state.layout.splitMode,
      splitRatio: state.layout.splitRatio,
      activePaneId: state.layout.activePaneId,
      panes: {
        primary: clonePaneState(state.layout.panes.primary),
        secondary: clonePaneState(state.layout.panes.secondary)
      }
    }
  }
}

export function cloneWorkspaceStateDocument(
  doc: WorkspaceStateDocument
): WorkspaceStateDocument {
  const workspaces: Record<string, PersistedWorkspaceState> = {}
  for (const [key, entry] of Object.entries(doc.workspaces)) {
    workspaces[key] = clonePersistedWorkspaceState(entry)
  }
  return {
    version: WORKSPACE_STATE_VERSION,
    workspaces
  }
}

export function filterExpandedDirsForWorkspace(
  rootPath: string,
  dirs: readonly string[]
): string[] {
  const normalizedRoot = resolveNormalizedWorkspacePath(rootPath)
  if (!normalizedRoot) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const rawDir of dirs) {
    const resolved = resolveWorkspaceChildPath(normalizedRoot, rawDir)
    if (!resolved) continue
    const key = getWorkspacePathKey(resolved)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

function normalizeEditorModeValue(value: unknown): EditorMode {
  return value === 'raw' || value === 'preview' || value === 'wysiwyg' || value === 'split'
    ? value
    : 'raw'
}

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizeCursor(value: unknown): CursorPosition {
  if (!isPlainRecord(value)) {
    return { selectionStart: 0, selectionEnd: 0 }
  }
  return {
    selectionStart: normalizeNonNegativeInt(value.selectionStart),
    selectionEnd: normalizeNonNegativeInt(value.selectionEnd)
  }
}

function normalizeScrollTop(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function normalizeTabState(
  normalizedRoot: string,
  raw: unknown
): PersistedWorkspaceTabState | null {
  if (!isPlainRecord(raw) || typeof raw.path !== 'string') {
    return null
  }
  const resolvedPath = resolveWorkspaceChildPath(normalizedRoot, raw.path)
  if (!resolvedPath) {
    return null
  }
  return {
    path: resolvedPath,
    mode: normalizeEditorModeValue(raw.mode),
    cursor: normalizeCursor(raw.cursor),
    scrollTop: normalizeScrollTop(raw.scrollTop),
    splitPreviewRatio:
      typeof raw.splitPreviewRatio === 'number'
        ? normalizeSplitRatio(raw.splitPreviewRatio)
        : DEFAULT_SPLIT_RATIO
  }
}

function dedupeTabStates(
  tabs: readonly PersistedWorkspaceTabState[]
): PersistedWorkspaceTabState[] {
  const seen = new Set<string>()
  const deduped: PersistedWorkspaceTabState[] = []
  for (const tab of tabs) {
    const key = getWorkspacePathKey(tab.path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(cloneTabState(tab))
  }
  return deduped
}

function resolveActiveTabPath(
  tabs: readonly PersistedWorkspaceTabState[],
  candidate: string | null
): string | null {
  if (tabs.length === 0) return null
  if (candidate) {
    const matched = tabs.find((tab) => isSameWorkspacePath(tab.path, candidate))
    if (matched) return matched.path
  }
  return tabs[0].path
}

function normalizePaneState(
  normalizedRoot: string,
  raw: unknown
): PersistedWorkspacePaneState {
  if (!isPlainRecord(raw)) {
    return { tabs: [], activeTabPath: null }
  }
  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : []
  const validTabs: PersistedWorkspaceTabState[] = []
  for (const rawTab of rawTabs) {
    const normalized = normalizeTabState(normalizedRoot, rawTab)
    if (normalized) {
      validTabs.push(normalized)
    }
  }
  return reconcilePaneState({
    tabs: validTabs,
    activeTabPath: typeof raw.activeTabPath === 'string' ? raw.activeTabPath : null
  })
}

function reconcilePaneState(pane: PersistedWorkspacePaneState): PersistedWorkspacePaneState {
  const tabs = dedupeTabStates(pane.tabs)
  return {
    tabs,
    activeTabPath: resolveActiveTabPath(tabs, pane.activeTabPath)
  }
}

function toSinglePaneLayout(
  splitRatio: number,
  primary: PersistedWorkspacePaneState
): PersistedWorkspacePaneLayout {
  return {
    splitMode: 'single',
    splitRatio,
    activePaneId: 'primary',
    panes: {
      primary,
      secondary: { tabs: [], activeTabPath: null }
    }
  }
}

function mapValidWorkspaceTabs(
  normalizedRoot: string,
  candidates: readonly PersistedWorkspaceTabState[],
  resolveCandidatePath: (tabPath: string) => string | null = (tabPath) => tabPath
): { tabs: PersistedWorkspaceTabState[]; hadDropped: boolean } {
  const tabs: PersistedWorkspaceTabState[] = []
  let hadDropped = false
  for (const tab of candidates) {
    const resolvedInputPath = resolveCandidatePath(tab.path)
    const canonicalChildPath = resolvedInputPath
      ? resolveWorkspaceChildPath(normalizedRoot, resolvedInputPath)
      : null
    if (!canonicalChildPath) {
      hadDropped = true
      continue
    }
    tabs.push({ ...tab, path: canonicalChildPath })
  }
  return { tabs, hadDropped }
}

/**
 * Filters a persisted pane's candidate tabs to valid strict children inside `normalizedRoot`.
 */
export function filterPersistedPaneTabsForWorkspace(
  normalizedRoot: string,
  pane: PersistedWorkspacePaneState
): { tabs: PersistedWorkspaceTabState[]; hadInvalid: boolean } {
  const { tabs, hadDropped } = mapValidWorkspaceTabs(normalizedRoot, pane.tabs)
  return { tabs, hadInvalid: hadDropped }
}

/**
 * Reconciles a candidate persisted pane layout against successfully loaded canonical workspace paths.
 */
export function reconcileLoadedWorkspaceLayout(
  normalizedRoot: string,
  persistedLayout: PersistedWorkspacePaneLayout,
  primaryCandidates: readonly PersistedWorkspaceTabState[],
  secondaryCandidates: readonly PersistedWorkspaceTabState[],
  resolveLoadedPath: (tabPath: string) => string | null
): { reconciledLayout: PersistedWorkspacePaneLayout; hadDroppedTabs: boolean } {
  const primaryMapped = mapValidWorkspaceTabs(
    normalizedRoot,
    primaryCandidates,
    resolveLoadedPath
  )
  const secondaryMapped = mapValidWorkspaceTabs(
    normalizedRoot,
    secondaryCandidates,
    resolveLoadedPath
  )

  return {
    reconciledLayout: reconcilePersistedWorkspaceLayout({
      splitMode: persistedLayout.splitMode,
      splitRatio: persistedLayout.splitRatio,
      activePaneId: persistedLayout.activePaneId,
      panes: {
        primary: {
          tabs: primaryMapped.tabs,
          activeTabPath: persistedLayout.panes.primary.activeTabPath
        },
        secondary: {
          tabs: secondaryMapped.tabs,
          activeTabPath: persistedLayout.panes.secondary.activeTabPath
        }
      }
    }),
    hadDroppedTabs: primaryMapped.hadDropped || secondaryMapped.hadDropped
  }
}

/**
 * Reconciles a pane layout so empty secondary collapses to single mode, empty primary promotes
 * secondary tabs into primary, and activeTabPath stays valid within each pane.
 */
export function reconcilePersistedWorkspaceLayout(
  layout: PersistedWorkspacePaneLayout
): PersistedWorkspacePaneLayout {
  const splitRatio = normalizeSplitRatio(layout.splitRatio)
  const primary = reconcilePaneState(layout.panes.primary)
  const secondary = reconcilePaneState(layout.panes.secondary)

  if (primary.tabs.length === 0 && secondary.tabs.length > 0) {
    return toSinglePaneLayout(splitRatio, secondary)
  }

  if (secondary.tabs.length === 0) {
    return toSinglePaneLayout(splitRatio, primary)
  }

  if (layout.splitMode === 'single') {
    return toSinglePaneLayout(
      splitRatio,
      reconcilePaneState({
        tabs: [...primary.tabs, ...secondary.tabs],
        activeTabPath: primary.activeTabPath
      })
    )
  }

  return {
    splitMode: layout.splitMode,
    splitRatio,
    activePaneId: layout.activePaneId === 'secondary' ? 'secondary' : 'primary',
    panes: { primary, secondary }
  }
}

function normalizeWorkspacePaneLayout(
  normalizedRoot: string,
  raw: unknown
): PersistedWorkspacePaneLayout {
  if (!isPlainRecord(raw)) {
    return createEmptyPersistedWorkspaceLayout()
  }
  const panesRaw = isPlainRecord(raw.panes) ? raw.panes : {}
  const primary = normalizePaneState(normalizedRoot, panesRaw.primary)
  const secondary = normalizePaneState(normalizedRoot, panesRaw.secondary)
  const splitMode: SplitMode =
    raw.splitMode === 'single' || raw.splitMode === 'horizontal' || raw.splitMode === 'vertical'
      ? raw.splitMode
      : primary.tabs.length > 0 && secondary.tabs.length > 0
        ? 'horizontal'
        : 'single'
  const splitRatio =
    typeof raw.splitRatio === 'number' ? normalizeSplitRatio(raw.splitRatio) : DEFAULT_SPLIT_RATIO
  const activePaneId: PaneId = raw.activePaneId === 'secondary' ? 'secondary' : 'primary'

  return reconcilePersistedWorkspaceLayout({
    splitMode,
    splitRatio,
    activePaneId,
    panes: { primary, secondary }
  })
}

function normalizeUpdatedAt(raw: unknown): string {
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString()
    }
  }
  return EPOCH_ISO
}

export function normalizePersistedWorkspaceState(raw: unknown): PersistedWorkspaceState | null {
  if (!isPlainRecord(raw) || typeof raw.rootPath !== 'string') {
    return null
  }
  const normalizedRoot = resolveNormalizedWorkspacePath(raw.rootPath)
  if (!normalizedRoot) {
    return null
  }
  const rawDirs = Array.isArray(raw.expandedDirs)
    ? raw.expandedDirs.filter((item): item is string => typeof item === 'string')
    : []
  return {
    rootPath: normalizedRoot,
    updatedAt: normalizeUpdatedAt(raw.updatedAt),
    expandedDirs: filterExpandedDirsForWorkspace(normalizedRoot, rawDirs),
    layout: normalizeWorkspacePaneLayout(normalizedRoot, raw.layout)
  }
}

function pruneWorkspaceStatesLru(
  entries: ReadonlyArray<[string, PersistedWorkspaceState]>,
  maxWorkspaces: number
): Record<string, PersistedWorkspaceState> {
  const limit = Math.max(1, Math.floor(maxWorkspaces))
  const sorted = [...entries].sort(([, left], [, right]) => {
    const diff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return diff !== 0 ? diff : left.rootPath.localeCompare(right.rootPath)
  })
  const pruned: Record<string, PersistedWorkspaceState> = {}
  for (const [key, entry] of sorted.slice(0, limit)) {
    pruned[key] = entry
  }
  return pruned
}

/**
 * Normalizes a persisted WorkspaceStateDocument, dropping corrupt workspace entries, enforcing
 * path security and layout invariants, deduplicating canonical keys, and pruning oldest LRU entries.
 */
export function normalizeWorkspaceStateDocument(
  raw: unknown,
  options: NormalizeWorkspaceStateOptions = {}
): WorkspaceStateDocument {
  const maxWorkspaces = options.maxWorkspaces ?? DEFAULT_MAX_PERSISTED_WORKSPACES
  if (!isPlainRecord(raw) || !isPlainRecord(raw.workspaces)) {
    return createDefaultWorkspaceStateDocument()
  }

  const byKey = new Map<string, PersistedWorkspaceState>()
  for (const candidate of Object.values(raw.workspaces)) {
    const normalized = normalizePersistedWorkspaceState(candidate)
    if (!normalized) continue
    const key = getWorkspacePathKey(normalized.rootPath)
    if (!key) continue
    const existing = byKey.get(key)
    if (!existing || Date.parse(normalized.updatedAt) >= Date.parse(existing.updatedAt)) {
      byKey.set(key, normalized)
    }
  }

  return {
    version: WORKSPACE_STATE_VERSION,
    workspaces: pruneWorkspaceStatesLru([...byKey.entries()], maxWorkspaces)
  }
}

export function validateWorkspaceStateUpdate(update: unknown): asserts update is WorkspaceStateUpdate {
  if (!isPlainRecord(update)) {
    throw new Error('Workspace state update payload must be a plain object')
  }
  if (
    update.expandedDirs !== undefined &&
    (!Array.isArray(update.expandedDirs) ||
      !update.expandedDirs.every((item) => typeof item === 'string'))
  ) {
    throw new Error('Invalid expandedDirs: expected string[]')
  }
  if (update.layout !== undefined && !isPlainRecord(update.layout)) {
    throw new Error('Invalid layout: expected plain object')
  }
}

export function findWorkspaceStateInDocument(
  doc: WorkspaceStateDocument,
  rootPath: string
): PersistedWorkspaceState | null {
  const normalizedRoot = resolveNormalizedWorkspacePath(rootPath)
  if (!normalizedRoot) {
    return null
  }
  const found = doc.workspaces[getWorkspacePathKey(normalizedRoot)]
  return found ? clonePersistedWorkspaceState(found) : null
}

export function validateWorkspaceStateSaveInput(
  rootPath: string,
  update: unknown
): { normalizedRoot: string; update: WorkspaceStateUpdate } {
  validateWorkspaceStateUpdate(update)
  const normalizedRoot = resolveNormalizedWorkspacePath(rootPath)
  if (!normalizedRoot) {
    throw new Error('유효하지 않은 워크스페이스 경로입니다.')
  }
  return { normalizedRoot, update }
}

export function applyWorkspaceStateUpdate(
  currentDoc: WorkspaceStateDocument,
  rootPath: string,
  update: WorkspaceStateUpdate,
  updatedAt = new Date().toISOString(),
  options: NormalizeWorkspaceStateOptions = {}
): { document: WorkspaceStateDocument; workspaceState: PersistedWorkspaceState } {
  const { normalizedRoot } = validateWorkspaceStateSaveInput(rootPath, update)

  const key = getWorkspacePathKey(normalizedRoot)
  const existing = currentDoc.workspaces[key]
  const nextEntry: PersistedWorkspaceState = {
    rootPath: normalizedRoot,
    updatedAt: normalizeUpdatedAt(updatedAt),
    expandedDirs:
      update.expandedDirs !== undefined
        ? filterExpandedDirsForWorkspace(normalizedRoot, update.expandedDirs)
        : [...(existing?.expandedDirs ?? [])],
    layout:
      update.layout !== undefined
        ? normalizeWorkspacePaneLayout(normalizedRoot, update.layout)
        : existing
          ? clonePersistedWorkspaceState(existing).layout
          : createEmptyPersistedWorkspaceLayout()
  }

  const mergedDoc = cloneWorkspaceStateDocument(currentDoc)
  mergedDoc.workspaces[key] = nextEntry
  const normalizedDoc = normalizeWorkspaceStateDocument(mergedDoc, options)
  const persisted = normalizedDoc.workspaces[key] ?? nextEntry

  return {
    document: normalizedDoc,
    workspaceState: clonePersistedWorkspaceState(persisted)
  }
}
