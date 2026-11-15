import { useCallback, useRef } from 'react'
import { isMarkdownDocument } from '../editor/editorModes'
import { resolveMarkdownLinkTarget } from '../editor/MarkdownLinkNavigation'
import { findMarkdownHeadingBySlug, type MarkdownHeading } from '../editor/MarkdownTocEngine'
import type { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import type { PaneId, PaneLayoutState, TabItem } from '../stores/PaneTabStore'
import type { OpenedWorkspaceDocument } from './useEditorWorkspace'

/** Target tab and editor mode for a resolved heading scroll request. */
export interface HeadingScrollTarget {
  paneId: PaneId
  tab: Pick<TabItem, 'id' | 'mode'>
}

export interface UseMarkdownLinkNavigationOptions {
  panes: PaneLayoutState['panes']
  buffers: DocumentBufferSnapshot
  workspaceRootPath: string | null
  openWorkspaceFile: (
    filePath: string,
    targetPaneId?: PaneId,
    explicitName?: string
  ) => Promise<OpenedWorkspaceDocument | null>
  dispatchHeadingScroll: (target: HeadingScrollTarget, heading: MarkdownHeading, index: number) => void
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
  const linkNavigationSeqRef = useRef(0)
  const workspaceRootRef = useRef<string | null>(null)
  workspaceRootRef.current = workspaceRootPath

  const scrollToHeadingOrReport = useCallback(
    (target: HeadingScrollTarget, content: string, slug: string): void => {
      const match = findMarkdownHeadingBySlug(content, slug)
      if (!match) {
        reportErrorBanner(`섹션을 찾을 수 없습니다: #${slug}`)
        return
      }
      dispatchHeadingScroll(target, match.heading, match.index)
      reportErrorBanner(null)
    },
    [dispatchHeadingScroll, reportErrorBanner]
  )

  return useCallback(
    (paneId: PaneId, tabId: string, href: string): void => {
      const sourceTab = panes[paneId].tabs.find((tab) => tab.id === tabId)
      const sourceBuffer = sourceTab ? buffers[sourceTab.bufferKey] : undefined
      if (!sourceTab || !sourceBuffer || !isMarkdownDocument(sourceBuffer)) {
        return
      }

      const originWorkspaceRoot = workspaceRootPath
      const resolved = resolveMarkdownLinkTarget(href, {
        workspaceRootPath: originWorkspaceRoot,
        activeFilePath: sourceBuffer.kind === 'workspace' ? sourceBuffer.path : null
      })

      if (resolved.kind === 'external') {
        return
      }

      const navSeq = ++linkNavigationSeqRef.current
      if (resolved.kind === 'error') {
        reportErrorBanner(resolved.message)
        return
      }

      if (resolved.kind === 'same-doc-section') {
        scrollToHeadingOrReport({ paneId, tab: sourceTab }, sourceBuffer.content, resolved.slug)
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
          scrollToHeadingOrReport({ paneId, tab: opened.tab }, opened.buffer.content, resolved.slug)
        }
      })()
    },
    [
      buffers,
      openWorkspaceFile,
      panes,
      reportErrorBanner,
      scrollToHeadingOrReport,
      workspaceRootPath
    ]
  )
}
