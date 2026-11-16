export const TAB_DRAG_MIME = 'application/x-wiki-tab'
export const WORKSPACE_ENTRY_DRAG_MIME = 'application/x-wiki-workspace-entry'
export const WORKSPACE_IMAGE_DRAG_MIME = 'application/x-wiki-workspace-image'

/** Serializes workspace entry paths for HTML5 DataTransfer payloads. */
export function formatWorkspaceDragPaths(paths: readonly string[]): string {
  return paths.join('\n')
}

/** Parses newline-delimited workspace entry paths from an HTML5 DataTransfer payload. */
export function parseWorkspaceDragPaths(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(/\r?\n/).filter((line) => line.length > 0)
}
