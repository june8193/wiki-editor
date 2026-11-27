import { useCallback, useRef } from 'react'
import { isMarkdownDocument } from '../editor/editorModes'
import { resolveMarkdownLinkTarget } from '../editor/MarkdownLinkNavigation'
import { findMarkdownHeadingBySlug, type MarkdownHeading } from '../editor/MarkdownTocEngine'
import type { OutlineContextTarget } from '../editor/outlineScrollSpy'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { PaneId, PaneLayoutState } from '../stores/PaneTabStore'
import type { OpenedWorkspaceDocument } from './useEditorWorkspace'
import { useOptionalWikiApi } from './useWikiApi'

export interface UseMarkdownLinkNavigationOptions {
  panes: PaneLayoutState['panes']
  buffers: DocumentBufferSnapshot
  workspaceRootPath: string | null
  openWorkspaceFile: (
    filePath: string,
    targetPaneId?: PaneId,
    explicitName?: string
  ) => Promise<OpenedWorkspaceDocument | null>
  dispatchHeadingScroll: (
    context: OutlineContextTarget,
    content: string,
    heading: MarkdownHeading,
    index: number
  ) => void
  reportErrorBanner: (message: string | null, error?: unknown) => void
}

/**
 * Handles in-app navigation for markdown links (same-document headings and relative markdown files),
 * guarding against stale async resolutions across subsequent navigations or workspace switches.
 */
export function useMarkdownLinkNavigation({
  panes,
  buffers,
  workspaceRootPath,
  openWorkspaceFile,
  dispatchHeadingScroll,
  reportErrorBanner
}: UseMarkdownLinkNavigationOptions): (paneId: PaneId, tabId: string, href: string) => void {
  const wikiApi = useOptionalWikiApi() ?? (typeof window !== 'undefined' ? window.wikiApi : undefined)
  const linkNavigationSeqRef = useRef(0)
  const workspaceRootRef = useRef<string | null>(null)
  workspaceRootRef.current = workspaceRootPath

  const scrollToHeadingOrReport = useCallback(
    (context: OutlineContextTarget, content: string, slug: string): void => {
      const match = findMarkdownHeadingBySlug(content, slug)
      if (!match) {
        reportErrorBanner(`섹션을 찾을 수 없습니다: #${slug}`)
        return
      }
      dispatchHeadingScroll(context, content, match.heading, match.index)
      reportErrorBanner(null)
    },
    [dispatchHeadingScroll, reportErrorBanner]
  )

  return useCallback(
    (paneId: PaneId, tabId: string, href: string): void => {
      const sourceTab = panes[paneId].tabs.find((tab) => tab.id === tabId)
      if (!sourceTab || sourceTab.kind !== 'document') {
        return
      }
      const sourceBuffer = buffers[sourceTab.bufferKey]
      if (!sourceBuffer || !isMarkdownDocument(sourceBuffer)) {
        return
      }

      const originWorkspaceRoot = workspaceRootPath
      const resolved = resolveMarkdownLinkTarget(href, {
        workspaceRootPath: originWorkspaceRoot,
        activeFilePath: sourceBuffer.kind === 'workspace' ? sourceBuffer.path : null
      })

      if (resolved.kind === 'noop') {
        return
      }

      if (resolved.kind === 'external') {
        reportErrorBanner(null)
        const openExternalUrl = wikiApi?.shell?.openExternalUrl
        if (!openExternalUrl) {
          reportErrorBanner(`외부 링크를 열 수 없습니다: ${resolved.url}`)
          return
        }
        void openExternalUrl(resolved.url).then(
          (opened) => {
            if (!opened) {
              reportErrorBanner(`외부 링크를 열 수 없습니다: ${resolved.url}`)
            }
          },
          (error) => {
            reportErrorBanner(`외부 링크를 열 수 없습니다: ${resolved.url}`, error)
          }
        )
        return
      }

      const navSeq = ++linkNavigationSeqRef.current
      if (resolved.kind === 'error') {
        reportErrorBanner(resolved.message)
        return
      }

      if (resolved.kind === 'same-doc-section') {
        scrollToHeadingOrReport(
          { paneId, tabId: sourceTab.id, mode: sourceTab.mode },
          sourceBuffer.content,
          resolved.slug
        )
        return
      }

      reportErrorBanner(null)
      void (async () => {
        const opened = await openWorkspaceFile(resolved.targetPath, paneId)
        if (!opened) {
          return
        }
        if (
          linkNavigationSeqRef.current !== navSeq ||
          workspaceRootRef.current !== originWorkspaceRoot
        ) {
          return
        }
        if (resolved.slug !== null) {
          scrollToHeadingOrReport(
            { paneId, tabId: opened.tab.id, mode: opened.tab.mode },
            opened.buffer.content,
            resolved.slug
          )
        }
      })()
    },
    [
      buffers,
      openWorkspaceFile,
      panes,
      reportErrorBanner,
      scrollToHeadingOrReport,
      wikiApi,
      workspaceRootPath
    ]
  )
}
