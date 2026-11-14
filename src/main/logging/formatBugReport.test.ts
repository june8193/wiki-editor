import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatBugReport } from './formatBugReport'
import { LogService } from './LogService'

describe('LogService.readEntries & formatBugReport', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-report-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('merges rotated JSONL files oldest-to-newest, skips corrupt lines, and formats AI Markdown bug report with <=10 errors and <=50 chronological breadcrumbs', async () => {
    const logDir = join(tempDir, 'logs')
    const logService = new LogService(logDir, { maxFileSizeBytes: 6000, maxFiles: 3 })

    // Write 65 entries across multiple rotations: 52 info breadcrumbs + 13 errors/warnings
    for (let i = 1; i <= 52; i += 1) {
      await logService.info('ui', `breadcrumb-${String(i).padStart(2, '0')}`, {
        data: { step: i }
      })
    }

    for (let i = 1; i <= 13; i += 1) {
      if (i % 2 === 0) {
        await logService.warn('config', `warning-${String(i).padStart(2, '0')}`, {
          data: { attempt: i }
        })
      } else {
        const err = Object.assign(new Error(`failure-${String(i).padStart(2, '0')}`), {
          code: 128,
          signal: 'SIGTERM',
          stderr: `fatal stderr ${i}`,
          stdout: `partial stdout ${i}`
        })
        await logService.error('git', `error-${String(i).padStart(2, '0')}`, {
          data: { repo: 'C:\\wiki\\docs', index: i },
          error: err
        })
      }
    }

    // Inject a corrupt JSON line into active app.jsonl to verify fail-safe parsing
    await appendFile(logService.getLogFilePath(), '{not valid json\n\n', 'utf8')

    const entries = await logService.readEntries()
    expect(entries.length).toBeGreaterThan(20)
    // Verify chronological ordering of surviving entries
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].timestamp >= entries[i - 1].timestamp).toBe(true)
    }

    // Build deterministic entries to verify exact <=10 errors and <=50 breadcrumbs caps
    const syntheticEntries = [
      ...Array.from({ length: 55 }, (_, index) => ({
        timestamp: `2026-11-14T10:00:${String(index).padStart(2, '0')}.000Z`,
        level: 'info' as const,
        process: 'main' as const,
        category: 'app' as const,
        message: `activity-${String(index + 1).padStart(2, '0')}`
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        timestamp: `2026-11-14T10:01:${String(index).padStart(2, '0')}.000Z`,
        level: index % 3 === 0 ? ('warn' as const) : ('error' as const),
        process: 'main' as const,
        category: 'git' as const,
        message: `issue-${String(index + 1).padStart(2, '0')}`,
        data: { workspacePath: 'C:\\wiki\\notes', attempt: index + 1 },
        error:
          index % 3 === 0
            ? undefined
            : {
                name: 'Error',
                message: `git failed ${index + 1}`,
                stack: `Error: git failed ${index + 1}\n    at GitService.push (GitService.ts:224:11)`,
                code: 128,
                stderr: `fatal: authentication failed #${index + 1}`,
                stdout: `stdout line #${index + 1}`
              }
      }))
    ]

    const report = formatBugReport({
      entries: syntheticEntries,
      logFilePath: logService.getLogFilePath(),
      appVersion: '1.0.0',
      versions: {
        electron: '45.3.2',
        chrome: '136.0.0.0',
        node: '24.0.0'
      },
      os: {
        platform: 'win32',
        release: '10.0.22631',
        arch: 'x64'
      },
      generatedAt: new Date('2026-11-14T12:00:00.000Z')
    })

    // Environment & Log File Path
    expect(report).toContain('Wiki Editor: v1.0.0')
    expect(report).toContain('Electron: 45.3.2')
    expect(report).toContain('Chromium: 136.0.0.0')
    expect(report).toContain('Node.js: 24.0.0')
    expect(report).toContain('win32 10.0.22631 (x64)')
    expect(report).toContain('2026-11-14T12:00:00.000Z')
    expect(report).toContain(logService.getLogFilePath())

    // Recent Errors & Warnings: max 10 (issues 03..12 included, 01..02 excluded)
    const [beforeActivity, activitySection] = report.split('## Recent Activity (Breadcrumbs)')
    const errorsSection = beforeActivity.split('## Recent Errors & Warnings')[1]
    expect(errorsSection).toBeDefined()
    expect(errorsSection).not.toContain('issue-01')
    expect(errorsSection).not.toContain('issue-02')
    expect(errorsSection).toContain('issue-03')
    expect(errorsSection).toContain('issue-12')
    expect(errorsSection).toContain('at GitService.push (GitService.ts:224:11)')
    expect(errorsSection).toContain('fatal: authentication failed #12')
    expect(errorsSection).toContain('stdout line #12')
    expect(errorsSection).toContain('128')

    // Recent Activity (Breadcrumbs): max 50 out of 67 total entries (entries 18..67 -> activity-18..55 + issue-01..12)
    expect(activitySection).toBeDefined()
    expect(activitySection).not.toContain('activity-17')
    expect(activitySection).toContain('activity-18')
    expect(activitySection).toContain('activity-55')
    expect(activitySection).toContain('issue-12')
    expect(activitySection!.indexOf('activity-18')).toBeLessThan(
      activitySection!.indexOf('issue-12')
    )
  })

  it('handles empty logs and missing runtime versions gracefully', async () => {
    const emptyDir = join(tempDir, 'empty-logs')
    const logService = new LogService(emptyDir)

    const entries = await logService.readEntries()
    expect(entries).toEqual([])

    const report = formatBugReport({
      entries,
      logFilePath: logService.getLogFilePath(),
      appVersion: '1.0.0',
      versions: {},
      os: { platform: 'win32', release: '10.0', arch: 'x64' }
    })

    expect(report).toContain('Electron: unknown')
    expect(report).toContain('Chromium: unknown')
    expect(report).toContain('Node.js: unknown')
    expect(report).toContain('No errors or warnings recorded')
    expect(report).toContain('No activity recorded')
  })
})
