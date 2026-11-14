import type { LogEntry } from '@shared/logging'
import type { RuntimeVersions } from '../menu'

export const MAX_REPORT_ERRORS = 10
export const MAX_REPORT_BREADCRUMBS = 50

export interface BugReportOsInfo {
  platform: string
  release: string
  arch: string
}

export interface FormatBugReportInput {
  entries: readonly LogEntry[]
  logFilePath: string
  appVersion: string
  versions: RuntimeVersions
  os: BugReportOsInfo
  generatedAt?: Date
}

function formatCodeFence(content: string): string {
  const fence = content.includes('```') ? '````' : '```'
  return `${fence}\n${content}\n${fence}`
}

function formatErrorSection(entry: LogEntry): string {
  const lines: string[] = [
    `### [${entry.timestamp}] ${entry.level.toUpperCase()} [${entry.process}/${entry.category}] ${entry.message}`
  ]

  if (entry.error) {
    lines.push(`- Error: ${entry.error.name}: ${entry.error.message}`)
    if (entry.error.code !== undefined) {
      lines.push(`- Code: ${String(entry.error.code)}`)
    }
    if (entry.error.signal) {
      lines.push(`- Signal: ${entry.error.signal}`)
    }
    if (entry.error.stderr) {
      lines.push('- Stderr:')
      lines.push(formatCodeFence(entry.error.stderr))
    }
    if (entry.error.stdout) {
      lines.push('- Stdout:')
      lines.push(formatCodeFence(entry.error.stdout))
    }
    if (entry.error.stack) {
      lines.push('- Stack:')
      lines.push(formatCodeFence(entry.error.stack))
    }
  }

  if (entry.data && Object.keys(entry.data).length > 0) {
    lines.push(`- Context: \`${JSON.stringify(entry.data)}\``)
  }

  return lines.join('\n')
}

function formatBreadcrumbLine(entry: LogEntry): string {
  const parts = [
    `- [${entry.timestamp}] ${entry.level.toUpperCase()} [${entry.process}/${entry.category}] ${entry.message}`
  ]
  if (entry.data && Object.keys(entry.data).length > 0) {
    parts.push(`| ${JSON.stringify(entry.data)}`)
  }
  if (entry.error) {
    parts.push(`| error=${entry.error.name}: ${entry.error.message}`)
  }
  return parts.join(' ')
}

/**
 * Formats environment metadata, active log path, recent errors/warnings, and recent breadcrumbs as AI-ready Markdown.
 */
export function formatBugReport({
  entries,
  logFilePath,
  appVersion,
  versions,
  os,
  generatedAt = new Date()
}: FormatBugReportInput): string {
  const recentErrors = entries
    .filter((entry) => entry.level === 'error' || entry.level === 'warn')
    .slice(-MAX_REPORT_ERRORS)
  const recentBreadcrumbs = entries.slice(-MAX_REPORT_BREADCRUMBS)

  const environmentLines = [
    `## Environment`,
    `- Wiki Editor: v${appVersion}`,
    `- Electron: ${versions.electron ?? 'unknown'}`,
    `- Chromium: ${versions.chrome ?? 'unknown'}`,
    `- Node.js: ${versions.node ?? 'unknown'}`,
    `- OS: ${os.platform} ${os.release} (${os.arch})`,
    `- Generated At: ${generatedAt.toISOString()}`
  ]

  const logPathLines = [`## Log File Path`, `\`${logFilePath}\``]

  const errorLines = [
    `## Recent Errors & Warnings`,
    ...(recentErrors.length > 0
      ? recentErrors.map(formatErrorSection)
      : ['_No errors or warnings recorded._'])
  ]

  const breadcrumbLines = [
    `## Recent Activity (Breadcrumbs)`,
    ...(recentBreadcrumbs.length > 0
      ? recentBreadcrumbs.map(formatBreadcrumbLine)
      : ['_No activity recorded._'])
  ]

  return [
    '# Wiki Editor Bug Report',
    environmentLines.join('\n'),
    logPathLines.join('\n'),
    errorLines.join('\n\n'),
    breadcrumbLines.join('\n')
  ].join('\n\n')
}
