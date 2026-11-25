import { inspectUriScheme } from '@shared/urlSecurity'
import {
  isAbsoluteOrDrivePrefix,
  joinWorkspacePath,
  resolveRelativeWorkspacePath,
  resolveWorkspaceChildPath
} from '@shared/workspace'

export interface TerminalLineLinkSpan {
  startIndex: number
  endIndex: number
  text: string
}

export type ResolvedTerminalLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; targetPath: string; line?: number; column?: number }

const HTTP_URL_REGEX = /\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi
const FILE_PATH_REGEX =
  /(?:[a-zA-Z]:[\\/][^\s"'<>:|?*()[\]{}]+|(?:\.{1,2}[\\/]|[\\/])?(?:[a-zA-Z0-9_.-]+[\\/])*[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,10})(?::\d+(?::\d+)?)?/g
const TRAILING_URL_PUNCTUATION_REGEX = /[.,;:!?)'"\]]+$/
const WINDOWS_DRIVE_PATH_REGEX = /^[a-zA-Z]:[\\/]/
const FILE_LOCATION_SUFFIX_REGEX = /^(.*?):(\d+)(?::(\d+))?$/

function trimTrailingUrlPunctuation(rawUrl: string): string {
  return rawUrl.replace(TRAILING_URL_PUNCTUATION_REGEX, '')
}

function overlapsExistingSpan(
  startIndex: number,
  endIndex: number,
  existing: readonly TerminalLineLinkSpan[]
): boolean {
  return existing.some((span) => startIndex < span.endIndex && endIndex > span.startIndex)
}

/**
 * Finds `http`/`https` URLs and file-path (`path`, `path:line`, `path:line:col`) spans
 * within a single terminal buffer line, without overlapping URL spans.
 */
export function findTerminalLineLinks(lineText: string): TerminalLineLinkSpan[] {
  if (!lineText) return []

  const spans: TerminalLineLinkSpan[] = []

  HTTP_URL_REGEX.lastIndex = 0
  let urlMatch: RegExpExecArray | null
  while ((urlMatch = HTTP_URL_REGEX.exec(lineText)) !== null) {
    const trimmed = trimTrailingUrlPunctuation(urlMatch[0])
    if (!trimmed) continue
    spans.push({
      startIndex: urlMatch.index,
      endIndex: urlMatch.index + trimmed.length,
      text: trimmed
    })
  }

  FILE_PATH_REGEX.lastIndex = 0
  let fileMatch: RegExpExecArray | null
  while ((fileMatch = FILE_PATH_REGEX.exec(lineText)) !== null) {
    const startIndex = fileMatch.index
    const endIndex = startIndex + fileMatch[0].length
    if (overlapsExistingSpan(startIndex, endIndex, spans)) {
      continue
    }
    spans.push({
      startIndex,
      endIndex,
      text: fileMatch[0]
    })
  }

  spans.sort((a, b) => a.startIndex - b.startIndex)
  return spans
}

function parseFileLocation(rawTarget: string): {
  filePath: string
  line?: number
  column?: number
} {
  const match = FILE_LOCATION_SUFFIX_REGEX.exec(rawTarget)
  if (!match || !match[1]) {
    return { filePath: rawTarget }
  }
  const line = Number.parseInt(match[2], 10)
  const column = match[3] ? Number.parseInt(match[3], 10) : undefined
  if (!Number.isFinite(line) || line < 1) {
    return { filePath: rawTarget }
  }
  return {
    filePath: match[1],
    line,
    column: column && Number.isFinite(column) && column >= 1 ? column : undefined
  }
}

/**
 * Resolves a terminal link token to either a validated `http`/`https` external URL
 * or a workspace-scoped local file target with optional line/column, returning `null`
 * for unsafe URI schemes or paths outside `workspaceRootPath`.
 */
export function resolveTerminalLinkTarget(
  rawText: string,
  workspaceRootPath: string | null | undefined
): ResolvedTerminalLinkTarget | null {
  const trimmed = rawText.trim()
  if (!trimmed) return null

  if (!WINDOWS_DRIVE_PATH_REGEX.test(trimmed)) {
    const { valid, scheme } = inspectUriScheme(trimmed)
    if (!valid) {
      return null
    }
    if (scheme !== null) {
      if (scheme !== 'http' && scheme !== 'https') {
        return null
      }
      try {
        const parsed = new URL(trimmed)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return { kind: 'external', url: trimmed }
        }
      } catch {
        return null
      }
      return null
    }
  }

  if (!workspaceRootPath) {
    return null
  }

  const { filePath, line, column } = parseFileLocation(trimmed)
  if (!filePath) return null

  if (isAbsoluteOrDrivePrefix(filePath)) {
    const resolvedAbsolute = resolveWorkspaceChildPath(workspaceRootPath, filePath)
    if (!resolvedAbsolute) {
      return null
    }
    return { kind: 'file', targetPath: resolvedAbsolute, line, column }
  }

  const resolvedRelative = resolveRelativeWorkspacePath(
    workspaceRootPath,
    joinWorkspacePath(workspaceRootPath, '__terminal__'),
    filePath
  )
  if (!resolvedRelative.ok) {
    return null
  }
  return { kind: 'file', targetPath: resolvedRelative.targetPath, line, column }
}
