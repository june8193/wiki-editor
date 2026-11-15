import { describe, expect, it } from 'vitest'
import {
  buildWikiAssetUrl,
  formatMarkdownImage,
  getImageExtensionForMimeType,
  getImageMimeType,
  isSupportedImageFile,
  isSupportedImageMimeType,
  parseWikiAssetUrl,
  resolveImageDisplaySrc,
  toMarkdownRelativeImagePath,
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
    expect(
      parseWikiAssetUrl(resolveImageDisplaySrc('./assets/pic.png', '/vault/docs/guide.md'))
    ).toBe('/vault/docs/assets/pic.png')
    expect(
      parseWikiAssetUrl(
        resolveImageDisplaySrc('../shared/diagram.svg', '/vault/docs/guide/intro.md')
      )
    ).toBe('/vault/docs/shared/diagram.svg')
    expect(
      parseWikiAssetUrl(
        resolveImageDisplaySrc(
          './assets/my%20pic%20%281%29.png',
          'C:\\vault\\docs\\guide\\intro.md'
        )
      )
    ).toBe('C:\\vault\\docs\\guide\\assets\\my pic (1).png')
    expect(
      parseWikiAssetUrl(resolveImageDisplaySrc('images/photo (2).jpg', 'C:\\vault\\docs\\intro.md'))
    ).toBe('C:\\vault\\docs\\images\\photo (2).jpg')
  })

  it('does not treat external, protocol-relative, root-absolute, or dangerous URLs as local assets', () => {
    const docPath = '/vault/docs/guide.md'

    expect(resolveImageDisplaySrc('https://example.com/a.png', docPath)).toBe(
      'https://example.com/a.png'
    )
    expect(resolveImageDisplaySrc('http://example.com/a.png', docPath)).toBe(
      'http://example.com/a.png'
    )
    expect(resolveImageDisplaySrc('./assets/pic.png', docPath)).toBe(
      buildWikiAssetUrl('/vault/docs/assets/pic.png')
    )
    expect(resolveImageDisplaySrc('./assets/pic.png')).toBe('./assets/pic.png')
    expect(resolveImageDisplaySrc('C:\\Users\\a.png', 'C:\\vault\\guide.md')).toBe('')
    expect(resolveImageDisplaySrc('wiki-asset://local/asset?path=/vault/a.png', docPath)).toBe('')
    expect(resolveImageDisplaySrc('javascript:alert(1)', docPath)).toBe('')
    expect(resolveImageDisplaySrc('data:image/png;base64,AAA', docPath)).toBe('')
    expect(resolveImageDisplaySrc('//evil.com/a.png', docPath)).toBe('')
    expect(resolveImageDisplaySrc('/abs/a.png', docPath)).toBe('')
    expect(resolveImageDisplaySrc('//evil.com/a.png')).toBe('')
    expect(resolveImageDisplaySrc('/abs/a.png')).toBe('')
  })

  it('resolves supported MIME types to canonical image extensions and checks image files', () => {
    expect(getImageExtensionForMimeType('image/png')).toBe('.png')
    expect(getImageExtensionForMimeType('IMAGE/JPEG; charset=utf-8')).toBe('.jpg')
    expect(getImageExtensionForMimeType('image/gif')).toBe('.gif')
    expect(getImageExtensionForMimeType('image/webp')).toBe('.webp')
    expect(getImageExtensionForMimeType('image/svg+xml')).toBe('.svg')
    expect(getImageExtensionForMimeType('image/bmp')).toBe('.bmp')
    expect(getImageExtensionForMimeType('image/avif')).toBe('.avif')
    expect(getImageExtensionForMimeType('text/plain')).toBeNull()
    expect(getImageExtensionForMimeType('image/tiff')).toBeNull()

    expect(isSupportedImageMimeType('image/png')).toBe(true)
    expect(isSupportedImageMimeType('application/pdf')).toBe(false)
    expect(isSupportedImageFile('photo.PNG')).toBe(true)
    expect(isSupportedImageFile('notes.md')).toBe(false)
  })

  it('percent-encodes CommonMark delimiters in relative POSIX paths and roundtrips through resolveImageDisplaySrc', () => {
    expect(toMarkdownRelativeImagePath('assets/logo (1).png')).toBe(
      './assets/logo%20%281%29.png'
    )
    expect(toMarkdownRelativeImagePath('pic.png')).toBe('./pic.png')
    expect(toMarkdownRelativeImagePath('../shared folder/diagram [v2]#1?.svg')).toBe(
      '../shared%20folder/diagram%20%5Bv2%5D%231%3F.svg'
    )
    expect(toMarkdownRelativeImagePath('assets/100% ready.png')).toBe(
      './assets/100%25%20ready.png'
    )
    expect(toMarkdownRelativeImagePath('assets/가이드 (초안).png')).toBe(
      './assets/가이드%20%28초안%29.png'
    )

    const encoded = toMarkdownRelativeImagePath('../shared folder/diagram (1)#v2?.svg')
    expect(parseWikiAssetUrl(resolveImageDisplaySrc(encoded, 'C:\\vault\\docs\\guide.md'))).toBe(
      'C:\\vault\\shared folder\\diagram (1)#v2?.svg'
    )

    expect(
      formatMarkdownImage({ altText: 'diagram', markdownPath: './assets/diagram.png' })
    ).toBe('![diagram](./assets/diagram.png)')
    expect(
      formatMarkdownImage({
        altText: 'step [1]\nnext',
        markdownPath: './assets/step%20%5B1%5D.png'
      })
    ).toBe('![step \\[1\\] next](./assets/step%20%5B1%5D.png)')
  })
})
