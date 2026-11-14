import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '@shared/logging'
import { LogService } from './LogService'

describe('LogService', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-log-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes JSONL records to app.jsonl in injected dir, preserves order under concurrency, and fails safely on I/O errors', async () => {
    const logDir = join(tempDir, 'logs')
    const service = new LogService(logDir)

    expect(service.getLogDir()).toBe(logDir)
    expect(service.getLogFilePath()).toBe(join(logDir, 'app.jsonl'))

    const sampleError = Object.assign(new Error('git push failed'), {
      code: 128,
      stderr: 'fatal: repository not found',
      stdout: ''
    })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index === 19
          ? service.error('git', `entry-${index}`, {
              data: { step: index },
              error: sampleError
            })
          : service.info('app', `entry-${index}`, { data: { step: index } })
      )
    )

    const raw = await readFile(service.getLogFilePath(), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(20)

    const parsed = lines.map((line) => JSON.parse(line) as LogEntry)
    expect(parsed.map((entry) => entry.message)).toEqual(
      Array.from({ length: 20 }, (_, index) => `entry-${index}`)
    )

    expect(parsed[0]).toMatchObject({
      level: 'info',
      process: 'main',
      category: 'app',
      message: 'entry-0',
      data: { step: 0 }
    })
    expect(Date.parse(parsed[0].timestamp)).not.toBeNaN()

    expect(parsed[19]).toMatchObject({
      level: 'error',
      process: 'main',
      category: 'git',
      message: 'entry-19',
      data: { step: 19 },
      error: {
        name: 'Error',
        message: 'git push failed',
        code: 128,
        stderr: 'fatal: repository not found'
      }
    })
    expect(parsed[19].error?.stack).toContain('git push failed')

    // Fail-safe: point logDir to an existing regular file so mkdir/write fails
    const blockingFilePath = join(tempDir, 'not-a-directory')
    await writeFile(blockingFilePath, 'blocked', 'utf8')
    const brokenService = new LogService(blockingFilePath)

    await expect(brokenService.error('app', 'should not throw')).resolves.toBeUndefined()
    await expect(brokenService.flush()).resolves.toBeUndefined()
  })

  it('rotates app.jsonl -> app.1.jsonl -> app.2.jsonl when exceeding 2MB and retains at most 3 files', async () => {
    const defaultLogDir = join(tempDir, 'default-rotation')
    const defaultService = new LogService(defaultLogDir)

    await defaultService.ensureLogDir()
    expect((await stat(defaultLogDir)).isDirectory()).toBe(true)

    // Write 5 entries of ~520KB each (~2.6MB total) to exceed the default 2MB threshold
    const bigPayload = 'x'.repeat(520 * 1024)
    for (let i = 0; i < 5; i += 1) {
      await defaultService.info('app', `chunk-${i}`, { data: { payload: bigPayload } })
    }

    const rotatedFiles = (await readdir(defaultLogDir)).sort()
    expect(rotatedFiles).toEqual(['app.1.jsonl', 'app.jsonl'])
    expect((await stat(join(defaultLogDir, 'app.jsonl'))).size).toBeLessThanOrEqual(
      2 * 1024 * 1024
    )

    // Verify full 3-file rotation cycle drops oldest archive beyond app.2.jsonl
    const smallLimitDir = join(tempDir, 'small-limit')
    const smallLimitService = new LogService(smallLimitDir, { maxFileSizeBytes: 300, maxFiles: 3 })
    for (let i = 1; i <= 10; i += 1) {
      await smallLimitService.info('app', `msg-${String(i).padStart(2, '0')}`, {
        data: { pad: 'y'.repeat(120) }
      })
    }

    const files = (await readdir(smallLimitDir)).sort()
    expect(files).toEqual(['app.1.jsonl', 'app.2.jsonl', 'app.jsonl'])

    const activeRaw = await readFile(join(smallLimitDir, 'app.jsonl'), 'utf8')
    const archive1Raw = await readFile(join(smallLimitDir, 'app.1.jsonl'), 'utf8')
    const archive2Raw = await readFile(join(smallLimitDir, 'app.2.jsonl'), 'utf8')

    expect(activeRaw).toContain('msg-10')
    expect(archive1Raw).not.toContain('msg-10')
    expect(archive2Raw).not.toContain('msg-01')
  })
})
