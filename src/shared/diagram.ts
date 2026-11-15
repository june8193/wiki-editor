import type { DiagramExportFormat } from './ipc'

const WINDOWS_FORBIDDEN_FILENAME_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g
const EDGE_SPACES_AND_DOTS_RE = /^[\s.]+|[\s.]+$/g

/**
 * Strips Windows-forbidden filename characters and leading/trailing spaces or periods.
 */
export function sanitizeDiagramFileNamePart(raw: string): string {
  return raw.replace(WINDOWS_FORBIDDEN_FILENAME_CHARS_RE, '').replace(EDGE_SPACES_AND_DOTS_RE, '')
}

/**
 * Sanitizes an IPC-provided export filename and enforces the target `.png`/`.svg` extension.
 */
export function normalizeDiagramSuggestedFileName(
  suggestedName: unknown,
  format: DiagramExportFormat
): string {
  if (typeof suggestedName !== 'string') {
    return `mermaid-diagram.${format}`
  }

  const cleanedBase = suggestedName
    .replace(WINDOWS_FORBIDDEN_FILENAME_CHARS_RE, '')
    .replace(/[\s.]+$/g, '')
    .replace(/\.(png|svg)$/i, '')
    .replace(EDGE_SPACES_AND_DOTS_RE, '')
  const baseName = cleanedBase.length > 0 ? cleanedBase : 'mermaid-diagram'
  return `${baseName}.${format}`
}
