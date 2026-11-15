import { describe, expect, it } from 'vitest'
import {
  buildWikiAssetUrl,
  getImageMimeType,
  parseWikiAssetUrl,
  resolveImageDisplaySrc,
  resolveWorkspaceImagePath,
  WIKI_ASSET_SCHEME
} from './assets'

describe('shared assets helpers', () => {
  it('supports the required image extensions case-insensitively and resolves MIME types', () => {
    expect(getImageMimeType('diagram.png')).toBe('image/png')
    expect(getImageMimeType('PHOTO.JPG')).toBe('image/jpeg')
    expect(getImageMimeType('photo.JPEG')).toBe('image/jpeg')
    expect(getImageMimeType('anim.gif')).toBe('image/gif')
    expect(getImageMimeType('modern.WebP')).toBe('image/webp')
    expect(getImageMimeType('vector.svg')).toBe('image/svg+xml')
    expect(getImageMimeType('bitmap.bmp')).toBe('image/bmp')
    expect(getImageMimeType('hero.AVIF')).toBe('image/avif')

    expect(getImageMimeType('assets/pic (1).PNG')).toBe('image/png')
    expect(getImageMimeType('notes/readme.md')).toBeNull()
    expect(getImageMimeType('notes/script.html')).toBeNull()
    expect(getImageMimeType('notes/noext')).toBeNull()
    expect(getImageMimeType('.png')).toBeNull()
  })

  it('roundtrips POSIX and Windows paths with spaces and parentheses via wiki-asset URLs', () => {
    const posixPath = '/workspace/docs/assets/diagram (v1).png'
    const posixUrl = buildWikiAssetUrl(posixPath)
    expect(posixUrl.startsWith(`${WIKI_ASSET_SCHEME}://local/asset?path=`)).toBe(true)
    expect(parseWikiAssetUrl(posixUrl)).toBe(posixPath)

    const windowsPath = 'C:\\Users\\Wiki Editor\\vault\\assets\\my pic (1).webp'
    const windowsUrl = buildWikiAssetUrl(windowsPath)
    expect(windowsUrl.startsWith(`${WIKI_ASSET_SCHEME}://local/asset?path=`)).toBe(true)
    expect(parseWikiAssetUrl(windowsUrl)).toBe(windowsPath)

    expect(parseWikiAssetUrl('https://example.com/pic.png')).toBeNull()
    expect(parseWikiAssetUrl('wiki-asset://other/asset?path=/a.png')).toBeNull()
    expect(parseWikiAssetUrl('wiki-asset://local/other?path=/a.png')).toBeNull()
    expect(parseWikiAssetUrl('wiki-asset://local/asset')).toBeNull()
    expect(parseWikiAssetUrl('wiki-asset://local/asset?path=')).toBeNull()
    expect(parseWikiAssetUrl('not a valid url')).toBeNull()
  })

  it('resolves relative markdown image references against active document paths on POSIX and Windows', () => {
    expect(resolveWorkspaceImagePath('./assets/pic.png', '/vault/docs/guide.md')).toBe(
      '/vault/docs/assets/pic.png'
    )
    expect(resolveWorkspaceImagePath('../shared/diagram.svg', '/vault/docs/guide/intro.md')).toBe(
      '/vault/docs/shared/diagram.svg'
    )
    expect(
      resolveWorkspaceImagePath(
        './assets/my%20pic%20%281%29.png',
        'C:\\vault\\docs\\guide\\intro.md'
      )
    ).toBe('C:\\vault\\docs\\guide\\assets\\my pic (1).png')
    expect(
      resolveWorkspaceImagePath('images/photo (2).jpg', 'C:\\vault\\docs\\intro.md')
    ).toBe('C:\\vault\\docs\\images\\photo (2).jpg')
  })

  it('does not treat external, protocol-relative, root-absolute, or dangerous URLs as local assets', () => {
    const docPath = '/vault/docs/guide.md'

    expect(resolveWorkspaceImagePath('https://example.com/a.png', docPath)).toBeNull()
    expect(resolveWorkspaceImagePath('http://example.com/a.png', docPath)).toBeNull()
    expect(resolveWorkspaceImagePath('//evil.com/a.png', docPath)).toBeNull()
    expect(resolveWorkspaceImagePath('/abs/a.png', docPath)).toBeNull()
    expect(resolveWorkspaceImagePath('C:\\Users\\a.png', 'C:\\vault\\guide.md')).toBeNull()
    expect(resolveWorkspaceImagePath('wiki-asset://local/asset?path=/a.png', docPath)).toBeNull()
    expect(resolveWorkspaceImagePath('javascript:alert(1)', docPath)).toBeNull()
    expect(resolveWorkspaceImagePath('data:image/png;base64,AAA', docPath)).toBeNull()

    expect(resolveImageDisplaySrc('https://example.com/a.png', docPath)).toBe(
      'https://example.com/a.png'
    )
    expect(resolveImageDisplaySrc('./assets/pic.png', docPath)).toBe(
      buildWikiAssetUrl('/vault/docs/assets/pic.png')
    )
    expect(resolveImageDisplaySrc('./assets/pic.png')).toBe('./assets/pic.png')
    expect(resolveImageDisplaySrc('wiki-asset://local/asset?path=/vault/a.png', docPath)).toBe('')
    expect(resolveImageDisplaySrc('javascript:alert(1)', docPath)).toBe('')
  })
})
