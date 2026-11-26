import { normalizeAllowedHttpUrl } from '@shared/urlSecurity'
import {
  isAbsoluteOrDrivePrefix,
  isMarkdownFileName,
  resolveRelativeWorkspacePath
} from '@shared/workspace'
import { decodeSlugSafely } from './MarkdownTocEngine'

export interface MarkdownLinkContext {
  workspaceRootPath: string | null
  activeFilePath: string | null
}

export type ResolvedMarkdownLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'noop' }
  | { kind: 'same-doc-section'; slug: string }
  | { kind: 'workspace-file'; targetPath: string; slug: string | null }
  | { kind: 'error'; message: string }

const URI_SCHEME_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]{1,}):/

function outsideWorkspaceError(targetHref: string): ResolvedMarkdownLinkTarget {
  return {
    kind: 'error',
    message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${targetHref}`
  }
}

function unwrapLinkHref(rawHref: string): string {
  const trimmed = rawHref.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Classifies and resolves a Markdown link target (external URL, same-document `#slug`, or
 * workspace-relative Markdown file link with optional `#slug`), rejecting workspace escapes,
 * non-Markdown files, and malformed paths.
 */
export function resolveMarkdownLinkTarget(
  rawHref: string,
  context: MarkdownLinkContext
): ResolvedMarkdownLinkTarget {
  const trimmed = unwrapLinkHref(rawHref)
  if (trimmed.length === 0) {
    return { kind: 'error', message: '링크 대상을 찾을 수 없습니다.' }
  }
  if (/^mailto:/i.test(trimmed)) {
    return { kind: 'noop' }
  }
  if (/^https?:/i.test(trimmed)) {
    const normalizedUrl = normalizeAllowedHttpUrl(trimmed)
    if (!normalizedUrl) {
      return { kind: 'error', message: `잘못된 외부 웹 링크입니다: ${trimmed}` }
    }
    return { kind: 'external', url: normalizedUrl }
  }
  if (isAbsoluteOrDrivePrefix(trimmed)) {
    return outsideWorkspaceError(trimmed)
  }
  if (URI_SCHEME_REGEX.test(trimmed)) {
    return { kind: 'error', message: `지원하지 않는 링크 형식입니다: ${trimmed}` }
  }

  if (trimmed.startsWith('#')) {
    const slug = decodeSlugSafely(trimmed.slice(1))
    if (slug.trim().length === 0) {
      return { kind: 'error', message: '섹션을 찾을 수 없습니다: #' }
    }
    return { kind: 'same-doc-section', slug }
  }

  const hashIndex = trimmed.indexOf('#')
  const rawPathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const rawFragmentPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : null

  let decodedPathPart: string
  try {
    decodedPathPart = decodeURIComponent(rawPathPart)
  } catch {
    return { kind: 'error', message: `잘못된 링크 경로입니다: ${trimmed}` }
  }

  if (isAbsoluteOrDrivePrefix(decodedPathPart)) {
    return outsideWorkspaceError(trimmed)
  }
  if (!context.workspaceRootPath || !context.activeFilePath) {
    return { kind: 'error', message: '현재 문서 경로를 확인할 수 없습니다.' }
  }

  const resolved = resolveRelativeWorkspacePath(
    context.workspaceRootPath,
    context.activeFilePath,
    decodedPathPart
  )
  if (!resolved.ok) {
    return resolved.reason === 'outside-workspace'
      ? outsideWorkspaceError(trimmed)
      : { kind: 'error', message: `대상 파일을 찾을 수 없습니다: ${trimmed}` }
  }

  if (!isMarkdownFileName(resolved.targetPath)) {
    return {
      kind: 'error',
      message: `지원하지 않는 링크 대상입니다 (마크다운 문서만 열 수 있습니다): ${trimmed}`
    }
  }

  const slug = rawFragmentPart !== null ? decodeSlugSafely(rawFragmentPart) : null
  return { kind: 'workspace-file', targetPath: resolved.targetPath, slug }
}
