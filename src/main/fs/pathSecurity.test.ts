import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posixEnotdirPaths = vi.hoisted(() => new Set<string>())

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const withEnotdirCheck =
    <TArgs extends [Parameters<typeof actual.realpath>[0], ...unknown[]], TReturn>(
      fn: (...args: TArgs) => Promise<TReturn>
    ) =>
    async (...args: TArgs): Promise<TReturn> => {
      const target = String(args[0])
      if (posixEnotdirPaths.has(resolve(target))) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, '${target}'`), {
          code: 'ENOTDIR'
        })
      }
      return fn(...args)
    }

  return {
    ...actual,
    realpath: withEnotdirCheck(actual.realpath),
    lstat: withEnotdirCheck(actual.lstat)
  }
})

import { resolveRealPathWithAncestor } from './pathSecurity'

describe('resolveRealPathWithAncestor', () => {
  let rootDir: string
  let outsideDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'wiki-pathsec-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'wiki-pathsec-out-'))
  })

  afterEach(async () => {
    posixEnotdirPaths.clear()
    await rm(rootDir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('walks up past missing and POSIX ENOTDIR ancestors when a deleted folder is now a regular file', async () => {
    await writeFile(join(rootDir, 'archived'), 'regular file blocking directory', 'utf8')
    const subPath = resolve(rootDir, 'archived', 'sub')
    const nestedFilePath = resolve(subPath, 'old-note.md')
    posixEnotdirPaths.add(subPath)
    posixEnotdirPaths.add(nestedFilePath)

    const resolved = await resolveRealPathWithAncestor(nestedFilePath)
    const realArchived = await resolveRealPathWithAncestor(join(rootDir, 'archived'))

    expect(resolved.exists).toBe(false)
    expect(resolved.resolvedReal).toBe(join(realArchived.resolvedReal, 'sub', 'old-note.md'))
  })

  it('still rejects dangling symlinks while resolving valid paths', async () => {
    const danglingLink = join(rootDir, 'dangling.md')
    try {
      await symlink(join(outsideDir, 'missing.md'), danglingLink)
    } catch {
      // Symlink creation may require Developer Mode on some Windows setups
      return
    }

    await expect(resolveRealPathWithAncestor(danglingLink)).rejects.toThrow(/심볼릭 링크/)
  })
})
