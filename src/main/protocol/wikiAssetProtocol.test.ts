import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWikiAssetUrl } from '@shared/assets'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import { handleWikiAssetRequest } from './wikiAssetProtocol'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')

describe('wikiAssetProtocol', () => {
  let tempRoot: string
  let workspaceDir: string
  let outsideDir: string
  let service: WorkspaceFsService

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wiki-asset-protocol-'))
    workspaceDir = path.join(tempRoot, 'vault')
    outsideDir = path.join(tempRoot, 'vault-outside')
    await mkdir(path.join(workspaceDir, 'assets'), { recursive: true })
    await mkdir(path.join(workspaceDir, '.git', 'assets'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    await writeFile(path.join(workspaceDir, 'assets', 'diagram (1).png'), PNG_BYTES)
    await writeFile(path.join(workspaceDir, 'assets', 'UPPER.PNG'), PNG_BYTES)
    await writeFile(path.join(workspaceDir, 'assets', 'vector.svg'), SVG_BYTES)
    await writeFile(path.join(workspaceDir, 'notes.md'), '# hello\n', 'utf8')
    await writeFile(path.join(workspaceDir, 'evil.html'), '<script>alert(1)</script>', 'utf8')
    await writeFile(path.join(workspaceDir, '.git', 'assets', 'secret.png'), PNG_BYTES)
    await writeFile(path.join(workspaceDir, 'node_modules', 'pkg', 'icon.png'), PNG_BYTES)
    await writeFile(path.join(outsideDir, 'secret.png'), PNG_BYTES)

    service = new WorkspaceFsService({ trashItem: async () => undefined })
  })

  afterEach(async () => {
    service.dispose()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('rejects unsupported HTTP methods and malformed wiki-asset URLs', async () => {
    await service.openWorkspace(workspaceDir)

    const validUrl = buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'diagram (1).png'))
    const postRes = await handleWikiAssetRequest(new Request(validUrl, { method: 'POST' }), service)
    expect(postRes.status).toBe(405)

    for (const badUrl of [
      'wiki-asset://other/asset?path=/a.png',
      'wiki-asset://local/wrong?path=/a.png',
      'wiki-asset://local/asset',
      'wiki-asset://local/asset?path='
    ]) {
      const res = await handleWikiAssetRequest(new Request(badUrl), service)
      expect(res.status).toBe(400)
    }
  })

  it('returns 403 when no workspace is open', async () => {
    const url = buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'diagram (1).png'))
    const res = await handleWikiAssetRequest(new Request(url), service)
    expect(res.status).toBe(403)
  })

  it('serves valid workspace images with MIME and CSP headers and handles HEAD requests', async () => {
    await service.openWorkspace(workspaceDir)

    const pngUrl = buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'diagram (1).png'))
    const pngRes = await handleWikiAssetRequest(new Request(pngUrl), service)
    expect(pngRes.status).toBe(200)
    expect(pngRes.headers.get('Content-Type')).toBe('image/png')
    expect(pngRes.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    )
    expect(Buffer.from(await pngRes.arrayBuffer())).toEqual(PNG_BYTES)

    const upperRes = await handleWikiAssetRequest(
      new Request(buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'UPPER.PNG'))),
      service
    )
    expect(upperRes.status).toBe(200)
    expect(upperRes.headers.get('Content-Type')).toBe('image/png')

    const svgUrl = buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'vector.svg'))
    const svgRes = await handleWikiAssetRequest(new Request(svgUrl), service)
    expect(svgRes.status).toBe(200)
    expect(svgRes.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(svgRes.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    )
    expect(await svgRes.text()).toBe(SVG_BYTES.toString('utf8'))

    const headRes = await handleWikiAssetRequest(new Request(pngUrl, { method: 'HEAD' }), service)
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get('Content-Type')).toBe('image/png')
    expect((await headRes.arrayBuffer()).byteLength).toBe(0)
  })

  it('blocks traversal, sibling prefix escape, ignored folders, and non-image files with 403', async () => {
    await service.openWorkspace(workspaceDir)

    const forbiddenTargets = [
      path.join(workspaceDir, '..', 'vault-outside', 'secret.png'),
      path.join(outsideDir, 'secret.png'),
      path.join(workspaceDir, '.git', 'assets', 'secret.png'),
      path.join(workspaceDir, 'node_modules', 'pkg', 'icon.png'),
      path.join(workspaceDir, 'notes.md'),
      path.join(workspaceDir, 'evil.html')
    ]

    for (const target of forbiddenTargets) {
      const res = await handleWikiAssetRequest(new Request(buildWikiAssetUrl(target)), service)
      expect(res.status).toBe(403)
    }
  })

  async function assertBlockedSymlink(targetPath: string, linkPath: string): Promise<void> {
    try {
      await symlink(targetPath, linkPath, 'file')
    } catch {
      // Skip symlink sub-case on hosts where symlink privileges are disabled
      return
    }
    const res = await handleWikiAssetRequest(new Request(buildWikiAssetUrl(linkPath)), service)
    expect(res.status).toBe(403)
  }

  it('blocks external symlinks and symlinks to non-image files', async () => {
    await service.openWorkspace(workspaceDir)

    await assertBlockedSymlink(
      path.join(outsideDir, 'secret.png'),
      path.join(workspaceDir, 'assets', 'outside-link.png')
    )
    await assertBlockedSymlink(
      path.join(workspaceDir, 'notes.md'),
      path.join(workspaceDir, 'assets', 'hidden-md.png')
    )
  })

  it('returns 404 for missing images and directory targets', async () => {
    await service.openWorkspace(workspaceDir)

    const missingRes = await handleWikiAssetRequest(
      new Request(buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'missing.png'))),
      service
    )
    expect(missingRes.status).toBe(404)

    await mkdir(path.join(workspaceDir, 'assets', 'folder.png'), { recursive: true })
    const dirRes = await handleWikiAssetRequest(
      new Request(buildWikiAssetUrl(path.join(workspaceDir, 'assets', 'folder.png'))),
      service
    )
    expect(dirRes.status).toBe(404)
  })
})
