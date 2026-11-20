import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

  it('recursively lists markdown files (.md/.markdown case-insensitive), excludes system folders and unsafe symlinks, and requires an open workspace', async () => {
    await expect(service.listMarkdownFiles()).rejects.toThrow(/워크스페이스/)

    await mkdir(join(workspaceDir, '.git', 'hooks'), { recursive: true })
    await mkdir(join(workspaceDir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(workspaceDir, 'docs', 'api'), { recursive: true })
    await mkdir(join(workspaceDir, 'notes.md'), { recursive: true })

    await writeFile(join(workspaceDir, '.git', 'COMMIT_EDITMSG.md'), 'ignored', 'utf8')
    await writeFile(join(workspaceDir, 'node_modules', 'pkg', 'README.md'), 'ignored', 'utf8')
    await writeFile(join(workspaceDir, 'root.MD'), '# Root', 'utf8')
    await writeFile(join(workspaceDir, 'docs', 'guide.markdown'), '# Guide', 'utf8')
    await writeFile(join(workspaceDir, 'docs', 'api', 'spec.MarkDown'), '# Spec', 'utf8')
    await writeFile(join(workspaceDir, 'notes.md', 'inside-md-dir.md'), '# Inside', 'utf8')
    await writeFile(join(workspaceDir, 'docs', 'plain.txt'), 'text', 'utf8')
    await writeFile(join(workspaceDir, 'docs', 'README'), 'no ext', 'utf8')
    await writeFile(join(outsideDir, 'external.md'), '# External', 'utf8')

    let dirSymlinkCreated = false
    let fileSymlinkCreated = false
    try {
      await symlink(outsideDir, join(workspaceDir, 'outside-dir-link'), 'junction')
      await symlink(join(workspaceDir, '.git'), join(workspaceDir, 'git-dir-link'), 'junction')
      await symlink(join(workspaceDir, 'docs'), join(workspaceDir, 'docs', 'loop-link'), 'junction')
      dirSymlinkCreated = true
    } catch {
      dirSymlinkCreated = false
    }
    try {
      await symlink(join(outsideDir, 'external.md'), join(workspaceDir, 'outside-file.md'), 'file')
      await symlink(join(outsideDir, 'missing.md'), join(workspaceDir, 'dangling.md'), 'file')
      fileSymlinkCreated = true
    } catch {
      fileSymlinkCreated = false
    }

    await service.openWorkspace(workspaceDir)
    const entries = await service.listMarkdownFiles()

    expect(entries.map((entry) => entry.relativePath)).toEqual([
      'docs/api/spec.MarkDown',
      'docs/guide.markdown',
      'notes.md/inside-md-dir.md',
      'root.MD'
    ])
    expect(entries.every((entry) => entry.kind === 'file')).toBe(true)
    if (dirSymlinkCreated) {
      expect(entries.some((entry) => entry.relativePath.includes('outside-dir-link'))).toBe(false)
      expect(entries.some((entry) => entry.relativePath.includes('git-dir-link'))).toBe(false)
    }
    if (fileSymlinkCreated) {
      expect(entries.some((entry) => entry.name === 'outside-file.md')).toBe(false)
      expect(entries.some((entry) => entry.name === 'dangling.md')).toBe(false)
    }
  })

  it('coalesces rapid changes across distinct files into a null relativePath broadcast', async () => {
    await mkdir(join(workspaceDir, 'assets'), { recursive: true })
    const coalescedService = new WorkspaceFsService({ watchDebounceMs: 250 })
    try {
      await coalescedService.openWorkspace(workspaceDir)
      const events: Array<{ relativePath: string | null }> = []
      await coalescedService.watch((event) => {
        events.push({ relativePath: event.relativePath })
      })

      await Promise.all([
        writeFile(join(workspaceDir, 'first.md'), '# First', 'utf8'),
        writeFile(join(workspaceDir, 'assets', 'second.png'), 'PNG', 'utf8')
      ])

      await vi.waitFor(
        () => {
          expect(events.some((event) => event.relativePath === null)).toBe(true)
        },
        { timeout: 3000 }
      )
    } finally {
      await coalescedService.dispose()
    }
  })

  it('ingests clipboard images lazily into <docDir>/assets with local timestamps and -1/-2 collision suffixes', async () => {
    const docDir = join(workspaceDir, 'docs')
    const docPath = join(docDir, 'guide (1).md')
    await mkdir(docDir, { recursive: true })
    await writeFile(docPath, '# Guide\n', 'utf8')
    await service.openWorkspace(workspaceDir)

    const now = new Date(2026, 3, 2, 9, 5, 7).getTime()
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const first = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'clipboard', bytes: pngBytes, mimeType: 'image/png', now }
    })

    expect(first).toEqual({
      markdownPath: './assets/guide%20%281%29-20260402-090507.png',
      altText: 'guide (1)-20260402-090507',
      savedPath: join(docDir, 'assets', 'guide (1)-20260402-090507.png')
    })
    expect(await readFile(first.savedPath)).toEqual(Buffer.from(pngBytes))

    const secondBytes = new Uint8Array([1, 2, 3, 4])
    const second = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'clipboard', bytes: secondBytes, mimeType: 'image/png', now }
    })
    const third = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'clipboard', bytes: new Uint8Array([5, 6]), mimeType: 'image/png', now }
    })

    expect(second.savedPath).toBe(join(docDir, 'assets', 'guide (1)-20260402-090507-1.png'))
    expect(third.savedPath).toBe(join(docDir, 'assets', 'guide (1)-20260402-090507-2.png'))
    expect(await readFile(first.savedPath)).toEqual(Buffer.from(pngBytes))
    expect(await readFile(second.savedPath)).toEqual(Buffer.from(secondBytes))

    // Normalizes Windows-reserved document stems to "image" and resolves image/jpeg -> .jpg
    const reservedDocPath = join(workspaceDir, 'con.md')
    await writeFile(reservedDocPath, '# Reserved\n', 'utf8')
    const jpeg = await service.ingestImage({
      documentPath: reservedDocPath,
      source: { kind: 'clipboard', bytes: new Uint8Array([0xff, 0xd8]), mimeType: 'IMAGE/JPEG', now }
    })
    expect(jpeg).toEqual({
      markdownPath: './assets/image-20260402-090507.jpg',
      altText: 'image-20260402-090507',
      savedPath: join(workspaceDir, 'assets', 'image-20260402-090507.jpg')
    })
  })

  it('copies external filePath and fileBytes drops into <docDir>/assets preserving sanitized filenames and incrementing collisions', async () => {
    const docDir = join(workspaceDir, 'notes')
    const docPath = join(docDir, 'readme.md')
    await mkdir(docDir, { recursive: true })
    await writeFile(docPath, '# Notes\n', 'utf8')
    await service.openWorkspace(workspaceDir)

    const outsideImg = join(outsideDir, 'diagram (1).png')
    const outsideBytes = new Uint8Array([9, 8, 7, 6])
    await writeFile(outsideImg, outsideBytes)

    const fromPath = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'filePath', filePath: outsideImg }
    })
    expect(fromPath).toEqual({
      markdownPath: './assets/diagram%20%281%29.png',
      altText: 'diagram (1)',
      savedPath: join(docDir, 'assets', 'diagram (1).png')
    })
    expect(await readFile(fromPath.savedPath)).toEqual(Buffer.from(outsideBytes))

    const fromBytes = await service.ingestImage({
      documentPath: docPath,
      source: {
        kind: 'fileBytes',
        fileName: '../evil/diagram (1).png',
        bytes: new Uint8Array([4, 3, 2, 1])
      }
    })
    expect(fromBytes).toEqual({
      markdownPath: './assets/diagram%20%281%29-1.png',
      altText: 'diagram (1)-1',
      savedPath: join(docDir, 'assets', 'diagram (1)-1.png')
    })

    const reservedBytes = await service.ingestImage({
      documentPath: docPath,
      source: {
        kind: 'fileBytes',
        fileName: 'nul.webp',
        bytes: new Uint8Array([7, 7, 7])
      }
    })
    expect(reservedBytes).toEqual({
      markdownPath: './assets/image.webp',
      altText: 'image',
      savedPath: join(docDir, 'assets', 'image.webp')
    })
    expect((await stat(reservedBytes.savedPath)).isFile()).toBe(true)

    const uppercaseImg = join(outsideDir, 'Photo.PNG')
    await writeFile(uppercaseImg, new Uint8Array([3, 2, 1]))
    const uppercaseRes = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'filePath', filePath: uppercaseImg }
    })
    expect(uppercaseRes).toEqual({
      markdownPath: './assets/Photo.PNG',
      altText: 'Photo',
      savedPath: join(docDir, 'assets', 'Photo.PNG')
    })
  })

  it('references in-workspace images via POSIX relative CommonMark paths without copying or creating assets/', async () => {
    const docDir = join(workspaceDir, 'docs', 'sub folder')
    const docPath = join(docDir, 'page.md')
    const sharedDir = join(workspaceDir, 'shared images')
    const siblingImg = join(sharedDir, 'hero (1).png')
    const sameDirImg = join(docDir, 'local [icon].svg')

    await mkdir(docDir, { recursive: true })
    await mkdir(sharedDir, { recursive: true })
    await writeFile(docPath, '# Page\n', 'utf8')
    await writeFile(siblingImg, new Uint8Array([1, 2, 3]))
    await writeFile(sameDirImg, '<svg></svg>', 'utf8')
    await service.openWorkspace(workspaceDir)

    const fromSibling = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'filePath', filePath: siblingImg }
    })
    expect(fromSibling).toEqual({
      markdownPath: '../../shared%20images/hero%20%281%29.png',
      altText: 'hero (1)',
      savedPath: await lstat(siblingImg).then(() => siblingImg).catch(() => siblingImg)
    })

    const fromSameDir = await service.ingestImage({
      documentPath: docPath,
      source: { kind: 'filePath', filePath: sameDirImg }
    })
    expect(fromSameDir).toEqual({
      markdownPath: './local%20%5Bicon%5D.svg',
      altText: 'local [icon]',
      savedPath: sameDirImg
    })

    await expect(lstat(join(docDir, 'assets'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsupported formats, empty payloads, ignored system folders, and symlink escapes without creating assets/', async () => {
    const docDir = join(workspaceDir, 'docs')
    const docPath = join(docDir, 'guide.md')
    await mkdir(docDir, { recursive: true })
    await writeFile(docPath, '# Guide\n', 'utf8')

    // Rejects before workspace is opened
    await expect(
      service.ingestImage({
        documentPath: docPath,
        source: { kind: 'clipboard', bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }
      })
    ).rejects.toThrow()

    await service.openWorkspace(workspaceDir)

    // Non-image, unsupported MIME, and empty bytes
    await expect(
      service.ingestImage({
        documentPath: docPath,
        source: { kind: 'fileBytes', fileName: 'notes.txt', bytes: new Uint8Array([1, 2]) }
      })
    ).rejects.toThrow()
    await expect(
      service.ingestImage({
        documentPath: docPath,
        source: { kind: 'clipboard', bytes: new Uint8Array([1, 2]), mimeType: 'image/tiff' }
      })
    ).rejects.toThrow()
    await expect(
      service.ingestImage({
        documentPath: docPath,
        source: { kind: 'clipboard', bytes: new Uint8Array(0), mimeType: 'image/png' }
      })
    ).rejects.toThrow()

    // Document outside workspace or inside .git, or workspace subdirectory / missing file
    const outsideDoc = join(outsideDir, 'outside.md')
    await writeFile(outsideDoc, '# Outside\n', 'utf8')
    await expect(
      service.ingestImage({
        documentPath: outsideDoc,
        source: { kind: 'clipboard', bytes: new Uint8Array([1]), mimeType: 'image/png' }
      })
    ).rejects.toThrow()
    await expect(
      service.ingestImage({
        documentPath: docDir,
        source: { kind: 'clipboard', bytes: new Uint8Array([1]), mimeType: 'image/png' }
      })
    ).rejects.toThrow()
    await expect(
      service.ingestImage({
        documentPath: join(docDir, 'missing.md'),
        source: { kind: 'clipboard', bytes: new Uint8Array([1]), mimeType: 'image/png' }
      })
    ).rejects.toThrow()
    await expect(lstat(join(workspaceDir, 'assets'))).rejects.toMatchObject({ code: 'ENOENT' })

    // In-workspace image inside ignored system folder (.git)
    const gitImg = join(workspaceDir, '.git', 'hidden.png')
    await mkdir(join(workspaceDir, '.git'), { recursive: true })
    await writeFile(gitImg, new Uint8Array([1, 2, 3]))
    await expect(
      service.ingestImage({
        documentPath: docPath,
        source: { kind: 'filePath', filePath: gitImg }
      })
    ).rejects.toThrow()

    // External image path pointing to directory / missing file
    await expect(
      service.ingestImage({
        documentPath: docPath,
        source: { kind: 'filePath', filePath: outsideDir }
      })
    ).rejects.toThrow()

    // Workspace-internal symlink escaping outside workspace root
    const outsideImg = join(outsideDir, 'secret.png')
    await writeFile(outsideImg, new Uint8Array([1, 2, 3]))
    const escapeSymlink = join(workspaceDir, 'escape-image.png')
    try {
      await symlink(outsideImg, escapeSymlink)
      await expect(
        service.ingestImage({
          documentPath: docPath,
          source: { kind: 'filePath', filePath: escapeSymlink }
        })
      ).rejects.toThrow()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
        throw error
      }
    }

    await expect(lstat(join(docDir, 'assets'))).rejects.toMatchObject({ code: 'ENOENT' })

    // Symlinked <docDir>/assets directory escaping outside workspace root
    const symlinkedAssets = join(docDir, 'assets')
    try {
      await symlink(outsideDir, symlinkedAssets, 'dir')
      await expect(
        service.ingestImage({
          documentPath: docPath,
          source: { kind: 'clipboard', bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }
        })
      ).rejects.toThrow()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
        throw error
      }
    }
  })

  it('moves single/multiple entries cleanly, skips same-parent entries, deduplicates nested selections, and enforces all-or-nothing validation', async () => {
    await service.openWorkspace(workspaceDir)

    const folderA = await service.createEntry('.', 'folder-a', 'directory')
    const folderB = await service.createEntry('.', 'folder-b', 'directory')
    const subA = await service.createEntry(folderA.path, 'sub', 'directory')
    const note1 = await service.createEntry(folderA.path, 'note-1.md', 'file', '# Note 1')
    const subNote = await service.createEntry(subA.path, 'nested.md', 'file', '# Nested')
    const rootNote = await service.createEntry('.', 'root.md', 'file', '# Root')

    // 1. Move multiple items including parent folder + its nested child + item already in target
    const moved = await service.moveEntries(
      [subA.path, subNote.path, rootNote.path, note1.path],
      folderB.path
    )
    expect(moved.map((item) => item.entry.relativePath)).toEqual([
      'folder-b/sub',
      'folder-b/root.md',
      'folder-b/note-1.md'
    ])
    expect(moved.map((item) => item.oldPath)).toEqual([subA.path, rootNote.path, note1.path])

    // Already-in-target item should be skipped safely (no-op)
    const noopMoved = await service.moveEntries([moved[1].entry.path], folderB.path)
    expect(noopMoved).toEqual([])

    // Verify nested file moved along with parent folder
    expect(await readFile(join(folderB.path, 'sub', 'nested.md'), 'utf8')).toBe('# Nested')
    expect(await readFile(join(folderB.path, 'root.md'), 'utf8')).toBe('# Root')
    expect(await readFile(join(folderB.path, 'note-1.md'), 'utf8')).toBe('# Note 1')

    // 2. All-or-nothing collision check: existing name in target aborts entire batch
    const conflictInA = await service.createEntry(folderA.path, 'note-1.md', 'file', '# Conflict')
    const freshInA = await service.createEntry(folderA.path, 'fresh.md', 'file', '# Fresh')
    await expect(
      service.moveEntries([freshInA.path, conflictInA.path], folderB.path)
    ).rejects.toThrow(/이미 존재/)
    // fresh.md must NOT have moved
    expect(await service.readFile(freshInA.path)).toBe('# Fresh')
    await expect(lstat(join(folderB.path, 'fresh.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    // 3. All-or-nothing collision check: duplicate basenames from different folders in the same batch
    const subC = await service.createEntry('.', 'folder-c', 'directory')
    const dupInC = await service.createEntry(subC.path, 'fresh.md', 'file', '# Dup')
    await expect(service.moveEntries([freshInA.path, dupInC.path], folderB.path)).rejects.toThrow(
      /이미 존재/
    )
    expect(await service.readFile(freshInA.path)).toBe('# Fresh')
    expect(await service.readFile(dupInC.path)).toBe('# Dup')

    // 4. Reject moving a folder into itself or a descendant
    await expect(service.moveEntries([folderB.path], folderB.path)).rejects.toThrow(
      /자기 자신이나 하위 폴더/
    )
    await expect(
      service.moveEntries([folderB.path], join(folderB.path, 'sub'))
    ).rejects.toThrow(/자기 자신이나 하위 폴더/)

    // 5. Reject moving workspace root or escaping workspace root
    await expect(service.moveEntries(['.'], folderB.path)).rejects.toThrow(/루트/)
    await expect(service.moveEntries([outsideDir], folderB.path)).rejects.toThrow(/워크스페이스|경로/i)
    await expect(service.moveEntries([freshInA.path], outsideDir)).rejects.toThrow(/워크스페이스|경로/i)
  })

  it('lists all safe workspace files and reads bounded UTF-8 text files while skipping null-byte binaries and >2MB files', async () => {
    await mkdir(join(workspaceDir, '.git'), { recursive: true })
    await mkdir(join(workspaceDir, 'node_modules'), { recursive: true })
    await mkdir(join(workspaceDir, 'docs'), { recursive: true })
    await writeFile(join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')
    await writeFile(join(workspaceDir, 'node_modules', 'pkg.json'), '{}', 'utf8')
    await writeFile(join(workspaceDir, 'docs', 'guide.md'), '# Guide', 'utf8')
    await writeFile(join(workspaceDir, 'docs', 'notes.txt'), 'plain notes', 'utf8')
    await writeFile(join(workspaceDir, 'README'), 'no extension', 'utf8')
    await writeFile(
      join(workspaceDir, 'binary-in-probe.dat'),
      Buffer.concat([Buffer.from('header'), Buffer.from([0]), Buffer.from('body')])
    )
    await writeFile(
      join(workspaceDir, 'null-after-8kb.dat'),
      Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])
    )
    const exact2Mb = Buffer.alloc(2 * 1024 * 1024, 0x62)
    await writeFile(join(workspaceDir, 'exact-2mb.txt'), exact2Mb)
    await writeFile(
      join(workspaceDir, 'oversized.txt'),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x63)
    )

    await service.openWorkspace(workspaceDir)

    const allFiles = await service.listWorkspaceFiles()
    expect(allFiles.map((item) => item.relativePath)).toEqual([
      'binary-in-probe.dat',
      'docs/guide.md',
      'docs/notes.txt',
      'exact-2mb.txt',
      'null-after-8kb.dat',
      'oversized.txt',
      'README'
    ])

    expect(await service.readTextFileForSearch(join(workspaceDir, 'docs', 'notes.txt'))).toBe(
      'plain notes'
    )
    expect(await service.readTextFileForSearch(join(workspaceDir, 'binary-in-probe.dat'))).toBeNull()
    expect(
      await service.readTextFileForSearch(join(workspaceDir, 'null-after-8kb.dat'))
    ).not.toBeNull()
    expect(await service.readTextFileForSearch(join(workspaceDir, 'exact-2mb.txt'))).toHaveLength(
      2 * 1024 * 1024
    )
    expect(await service.readTextFileForSearch(join(workspaceDir, 'oversized.txt'))).toBeNull()
    await expect(
      service.readTextFileForSearch(join(outsideDir, 'secret.txt'))
    ).rejects.toThrow(/워크스페이스|경로/i)

    const controller = new AbortController()
    controller.abort()
    expect(await service.listWorkspaceFiles({ signal: controller.signal })).toEqual([])
    expect(
      await service.readTextFileForSearch(join(workspaceDir, 'docs', 'notes.txt'), {
        signal: controller.signal
      })
    ).toBeNull()
  })
})
