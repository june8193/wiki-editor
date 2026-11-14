import { type CustomCommandConfig, DEFAULT_TOC_COMMAND_TEMPLATE } from '@shared/config'
import {
  detectDocumentLineEnding,
  generateTocMarkdown,
  isOffsetInCodeFence
} from './MarkdownTocEngine'

export interface SlashQueryMatch {
  query: string
  rangeFrom: number
  rangeTo: number
}

export interface SlashQueryOptions {
  ignoreCodeFences?: boolean
}

export interface SlashTemplateContext {
  title?: string
  fileName?: string
  date?: string
  now?: Date
}

export interface ExpandedSlashTemplate {
  text: string
  cursorOffset: number
  hasCursorPlaceholder: boolean
}

export interface SlashCommandApplyResult {
  content: string
  cursorOffset: number
}

const CURSOR_PLACEHOLDER = '{{cursor}}'

/**
 * Derives a clean document title from a file name or title string by removing markdown extensions.
 */
export function deriveDocumentTitle(fileNameOrTitle?: string): string {
  const trimmed = fileNameOrTitle?.trim() ?? ''
  if (!trimmed) {
    return 'Untitled'
  }
  const stripped = trimmed.replace(/\.(md|markdown)$/i, '').trim()
  return stripped || trimmed
}

/**
 * Formats a Date into local `YYYY-MM-DD` string.
 */
export function formatLocalDate(date: Date = new Date()): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Detects an active `/query` trigger before the cursor offset.
 * Triggers only at start-of-line or immediately after whitespace, and ignores fenced code blocks by default.
 */
export function detectSlashQuery(
  text: string,
  cursorOffset: number,
  options: SlashQueryOptions = {}
): SlashQueryMatch | null {
  const clampedCursor = Math.max(0, Math.min(cursorOffset, text.length))
  if (options.ignoreCodeFences !== false && isOffsetInCodeFence(text, clampedCursor)) {
    return null
  }

  let lineStart = clampedCursor
  while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
    lineStart -= 1
  }

  const lineBeforeCursor = text.slice(lineStart, clampedCursor)
  const slashIndex = lineBeforeCursor.lastIndexOf('/')
  if (slashIndex === -1) {
    return null
  }

  if (slashIndex > 0 && !/\s/.test(lineBeforeCursor[slashIndex - 1])) {
    return null
  }

  const query = lineBeforeCursor.slice(slashIndex + 1)
  if (/\s/.test(query)) {
    return null
  }

  return {
    query,
    rangeFrom: lineStart + slashIndex,
    rangeTo: clampedCursor
  }
}

/**
 * Filters and ranks custom slash commands by exact trigger, prefix trigger, trigger substring,
 * and label/description substring while preserving configured order within each bucket.
 */
export function filterSlashCommands(
  commands: readonly CustomCommandConfig[],
  query: string
): CustomCommandConfig[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return [...commands]
  }

  const buckets: CustomCommandConfig[][] = [[], [], [], []]

  for (const command of commands) {
    const triggerLower = command.trigger.toLowerCase()
    if (triggerLower === normalized) {
      buckets[0].push(command)
    } else if (triggerLower.startsWith(normalized)) {
      buckets[1].push(command)
    } else if (triggerLower.includes(normalized)) {
      buckets[2].push(command)
    } else {
      const labelLower = command.label.toLowerCase()
      const descLower = command.description?.toLowerCase() ?? ''
      if (labelLower.includes(normalized) || descLower.includes(normalized)) {
        buckets[3].push(command)
      }
    }
  }

  return buckets.flat()
}

/**
 * Expands `{{date}}`, `{{title}}`, and `{{cursor}}` placeholders in a command template
 * and calculates the post-insertion cursor offset relative to the expanded text.
 */
export function expandSlashTemplate(
  template: string,
  context: SlashTemplateContext = {}
): ExpandedSlashTemplate {
  const resolvedDate = context.date ?? formatLocalDate(context.now)
  const resolvedTitle = context.title?.trim() || deriveDocumentTitle(context.fileName)

  const withVars = template.replace(/\{\{(date|title)\}\}/g, (_match, key: 'date' | 'title') =>
    key === 'date' ? resolvedDate : resolvedTitle
  )

  const firstCursorIndex = withVars.indexOf(CURSOR_PLACEHOLDER)
  if (firstCursorIndex === -1) {
    return {
      text: withVars,
      cursorOffset: withVars.length,
      hasCursorPlaceholder: false
    }
  }

  const text = withVars.split(CURSOR_PLACEHOLDER).join('')
  return {
    text,
    cursorOffset: firstCursorIndex,
    hasCursorPlaceholder: true
  }
}

/**
 * Returns true when a command represents the uncustomized default dynamic TOC generator command.
 */
export function isDefaultTocCommand(
  command: Pick<CustomCommandConfig, 'trigger' | 'template'>
): boolean {
  return command.trigger === 'toc' && command.template === DEFAULT_TOC_COMMAND_TEMPLATE
}

/**
 * Resolves the markdown snippet to insert for a selected slash command, generating a live TOC
 * block for the default `toc` command or expanding template placeholders otherwise.
 */
export function resolveSlashCommandSnippet(
  documentText: string,
  command: CustomCommandConfig,
  context: SlashTemplateContext = {}
): ExpandedSlashTemplate {
  if (isDefaultTocCommand(command)) {
    const tocBody = generateTocMarkdown(documentText)
    const text = tocBody ? `<!-- toc -->\n${tocBody}\n<!-- /toc -->` : '<!-- toc -->\n<!-- /toc -->'
    return {
      text,
      cursorOffset: text.length,
      hasCursorPlaceholder: false
    }
  }

  return expandSlashTemplate(command.template, context)
}

/**
 * Applies a slash command over the matched `/query` range in `documentText`,
 * preserving document line endings and returning the updated content and cursor offset.
 */
export function applySlashCommandToText(
  documentText: string,
  match: SlashQueryMatch,
  command: CustomCommandConfig,
  context: SlashTemplateContext = {}
): SlashCommandApplyResult {
  const lineEnding = detectDocumentLineEnding(documentText)
  const expanded = resolveSlashCommandSnippet(documentText, command, context)
  const convertLineEndings = (part: string): string =>
    part.replace(/\r\n?/g, '\n').replace(/\n/g, lineEnding)

  const beforeCursor = convertLineEndings(expanded.text.slice(0, expanded.cursorOffset))
  const afterCursor = convertLineEndings(expanded.text.slice(expanded.cursorOffset))
  const inserted = `${beforeCursor}${afterCursor}`

  return {
    content: documentText.slice(0, match.rangeFrom) + inserted + documentText.slice(match.rangeTo),
    cursorOffset: match.rangeFrom + beforeCursor.length
  }
}
