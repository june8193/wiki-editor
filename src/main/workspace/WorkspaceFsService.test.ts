import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFsService } from './WorkspaceFsService'

describe('WorkspaceFsService', () => {
  let tempRoot: string
  let workspaceDir: string
  let outsideDir: string
  let service: WorkspaceFsService

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wiki-editor-ws-'))
    workspaceDir = join(tempRoot, 'workspace')
    outsideDir = join(tempRoot, 'outside')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'secret.txt'), 'TOP_SECRET', 'utf8')
    service = new WorkspaceFsService()
  })

  afterEach(async () => {
    await service.dispose()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('opens workspace directory, performs 1-depth lazy readDir, sorts folders first, and filters system entries consistently', async () => {
    await mkdir(join(workspaceDir, '.git', 'objects'), { recursive: true })
    await mkdir(join(workspaceDir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(workspaceDir, 'zeta-folder'), { recursive: true })
    await mkdir(join(workspaceDir, 'Alpha-folder'), { recursive: true })
    await writeFile(join(workspaceDir, 'Alpha-folder', 'nested.md'), '# Nested', 'utf8')
    await writeFile(join(workspaceDir, 'b-note.md'), '# B', 'utf8')
    await writeFile(join(workspaceDir, 'A-note.md'), '# A', 'utf8')
    await writeFile(join(workspaceDir, '.DS_Store'), '', 'utf8')

    const info = await service.openWorkspace(workspaceDir)
    expect(info.name).toBe('workspace')
    // Top-level only: folders first (case-insensitive alpha), then files, excluding .git/node_modules/.DS_Store
    expect(info.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'directory:Alpha-folder',
      'directory:zeta-folder',
      'file:A-note.md',
      'file:b-note.md'
    ])

    // Lazy read of child folder returns 1-depth children
    const alphaChildren = await service.readDir(join(workspaceDir, 'Alpha-folder'))
    expect(alphaChildren.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['file:nested.md'])

    // Ignored system directories cannot be enumerated directly either or remain filtered consistently
    const dotGitChildren = await service.readDir('.git').catch(() => [])
    expect(dotGitChildren).toEqual([])
  })

  it('blocks path traversal, sibling-prefix escape, and symlink escape outside workspace root', async () => {
    await service.openWorkspace(workspaceDir)
    const siblingDir = join(tempRoot, 'workspace-sibling')
    await mkdir(siblingDir, { recursive: true })
    await writeFile(join(siblingDir, 'leak.md'), 'leak', 'utf8')

    await expect(service.readFile('../outside/secret.txt')).rejects.toThrow(/워크스페이스|경로/i)
    await expect(service.readFile(join(outsideDir, 'secret.txt'))).rejects.toThrow(/워크스페이스|경로/i)
    await expect(service.readFile(join(siblingDir, 'leak.md'))).rejects.toThrow(/워크스페이스|경로/i)
    await expect(service.writeFile(join(outsideDir, 'pwn.md'), 'bad')).rejects.toThrow(/워크스페이스|경로/i)
    await expect(service.createEntry(outsideDir, 'pwn.md', 'file')).rejects.toThrow(/워크스페이스|경로/i)
    await expect(service.deleteEntry(outsideDir)).rejects.toThrow(/워크스페이스|경로/i)

    // Test symlink escape, dangling symlinks, and symlink-to-ignored filtering if platform permissions allow
    const escapeLink = join(workspaceDir, 'escape-link')
    const gitDir = join(workspaceDir, '.git')
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main', 'utf8')
    const gitLink = join(workspaceDir, 'git-link')
    const danglingDirLink = join(workspaceDir, 'dangling-dir-link')
    const missingOutsideDir = join(outsideDir, 'missing-dir')
    let junctionCreated = false
    try {
      await symlink(outsideDir, escapeLink, 'junction')
      await symlink(gitDir, gitLink, 'junction')
      await symlink(missingOutsideDir, danglingDirLink, 'junction')
      junctionCreated = true
    } catch {
      junctionCreated = false
    }
    if (junctionCreated) {
      await expect(service.readFile(join(escapeLink, 'secret.txt'))).rejects.toThrow(/워크스페이스|경로/i)
      await expect(service.createEntry(escapeLink, 'new.md', 'file')).rejects.toThrow(/워크스페이스|경로/i)
      await expect(service.writeFile(danglingDirLink, 'bad')).rejects.toThrow(/심볼릭/)
      await expect(service.writeFile(join(danglingDirLink, 'pwn.md'), 'bad')).rejects.toThrow(/심볼릭/)
      await expect(service.readDir(danglingDirLink)).rejects.toThrow(/심볼릭/)
      const entries = await service.readDir()
      expect(entries.some((entry) => entry.name === 'git-link')).toBe(false)
      await expect(service.readDir(gitLink)).rejects.toThrow(/시스템 폴더/)
      await expect(service.readFile(join(gitLink, 'HEAD'))).rejects.toThrow(/시스템 폴더/)
      await expect(service.writeFile(join(gitLink, 'HEAD'), 'bad')).rejects.toThrow(/시스템 폴더/)
      await expect(service.createEntry(gitLink, 'evil.md', 'file')).rejects.toThrow(/시스템 폴더/)
    }

    const danglingFileLink = join(workspaceDir, 'dangling-file.md')
    const danglingOutsideTarget = join(outsideDir, 'dangling-pwned.md')
    let fileSymlinkCreated = false
    try {
      await symlink(danglingOutsideTarget, danglingFileLink, 'file')
      fileSymlinkCreated = true
    } catch {
      fileSymlinkCreated = false
    }
    if (fileSymlinkCreated) {
      await expect(service.writeFile(danglingFileLink, 'pwned')).rejects.toThrow(/워크스페이스|심볼릭|경로/i)
      await expect(lstat(danglingOutsideTarget)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('creates, reads, writes, renames, and deletes files and folders cleanly', async () => {
    await service.openWorkspace(workspaceDir)

    const folder = await service.createEntry('.', 'notes', 'directory')
    expect(folder).toMatchObject({ name: 'notes', kind: 'directory' })

    const createdFile = await service.createEntry(folder.path, 'guide.md', 'file', '# Hello')
    expect(createdFile).toMatchObject({ name: 'guide.md', kind: 'file' })
    expect(await service.readFile(createdFile.path)).toBe('# Hello')

    // Prevent overwrite on duplicate create
    await expect(service.createEntry(folder.path, 'guide.md', 'file')).rejects.toThrow(/이미 존재/)

    // Reject invalid entry names
    await expect(service.createEntry('.', '../bad.md', 'file')).rejects.toThrow()
    await expect(service.createEntry('.', '   ', 'file')).rejects.toThrow()

    await service.writeFile(createdFile.path, '# Updated')
    expect(await service.readFile(createdFile.path)).toBe('# Updated')

    const renamed = await service.renameEntry(createdFile.path, 'handbook.md')
    expect(renamed.name).toBe('handbook.md')
    expect(await service.readFile(renamed.path)).toBe('# Updated')

    // Case-only rename should succeed cleanly even on case-insensitive Windows filesystem
    const caseRenamed = await service.renameEntry(renamed.path, 'Handbook.md')
    expect(caseRenamed.name).toBe('Handbook.md')

    // Delete file and folder
    await service.deleteEntry(caseRenamed.path)
    expect(await service.readDir(folder.path)).toEqual([])

    await service.deleteEntry(folder.path)
    expect(await service.readDir()).toEqual([])

    // Deleting or renaming workspace root is forbidden (even with different drive/path casing on Windows)
    await expect(service.deleteEntry('.')).rejects.toThrow(/루트/)
    await expect(service.renameEntry('.', 'other')).rejects.toThrow(/루트/)
    const rootVariant =
      process.platform === 'win32'
        ? workspaceDir.toUpperCase()
        : workspaceDir
    await expect(service.deleteEntry(rootVariant)).rejects.toThrow(/루트/)
    await expect(service.renameEntry(rootVariant, 'other')).rejects.toThrow(/루트/)

    // Valid files whose names start with ".." inside the workspace must NOT be blocked as traversal
    const dotDotFile = await service.createEntry('.', '..notes.md', 'file', 'valid content')
    expect(await service.readFile(dotDotFile.path)).toBe('valid content')
    await service.deleteEntry(dotDotFile.path)
  })

  it('delegates deleteEntry to injected trashItem handler when configured', async () => {
    const trashItem = vi.fn(async (targetPath: string) => {
      await rm(targetPath, { recursive: true, force: true })
    })
    service = new WorkspaceFsService({ trashItem })
    await service.openWorkspace(workspaceDir)
    const file = await service.createEntry('.', 'trash-me.md', 'file', 'bye')

    await service.deleteEntry(file.path)
    expect(trashItem).toHaveBeenCalledTimes(1)
    expect(trashItem).toHaveBeenCalledWith(file.path)
  })

  it('watches workspace changes and cleans up watcher on unwatch/dispose', async () => {
    await service.openWorkspace(workspaceDir)
    const events: Array<{ relativePath: string | null }> = []

    const stopWatch = await service.watch((event) => {
      events.push({ relativePath: event.relativePath })
    })

    await writeFile(join(workspaceDir, 'live.md'), '# Live', 'utf8')
    await vi.waitFor(
      () => {
        expect(events.length).toBeGreaterThan(0)
      },
      { timeout: 3000 }
    )

    stopWatch()
    const countAfterStop = events.length
    await writeFile(join(workspaceDir, 'after-stop.md'), '# Later', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(events.length).toBe(countAfterStop)
  })
})
