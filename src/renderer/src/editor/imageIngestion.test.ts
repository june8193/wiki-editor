import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceImageIngestInput, WorkspaceImageIngestResult } from '@shared/assets'
import {
  TAB_DRAG_MIME,
  WORKSPACE_ENTRY_DRAG_MIME,
  WORKSPACE_IMAGE_DRAG_MIME
} from '../utils/dragMimeTypes'
import {
  extractClipboardImageSources,
  formatRawMarkdownImages,
  inspectDropTransfer,
  resolvePendingImageSources
} from './imageIngestion'

function createDataTransferStub(options: {
  types?: string[]
  files?: File[]
  items?: Array<{ kind: string; getAsFile: () => File | null }>
  dataByMime?: Record<string, string>
}): DataTransfer {
  const { types = [], files = [], items = [], dataByMime = {} } = options
  return {
    types,
    files: files as unknown as FileList,
    items: items as unknown as DataTransferItemList,
    getData: (mime: string) => dataByMime[mime] ?? ''
  } as unknown as DataTransfer
}

describe('imageIngestion helpers', () => {
  it('extractClipboardImageSources handles copied OS image paths, bitmap pastes, and text/plain exclusions', () => {
    expect(extractClipboardImageSources(null)).toEqual([])

    const copiedOsImg = new File([new Uint8Array([1, 2])], 'clip.png', { type: 'image/png' })
    const withPathAndPlainText = createDataTransferStub({
      files: [copiedOsImg],
      dataByMime: { 'text/plain': 'clip.png' }
    })
    expect(
      extractClipboardImageSources(withPathAndPlainText, {
        getPathForFile: (file) => (file === copiedOsImg ? 'C:/images/clip.png' : '')
      })
    ).toEqual([{ kind: 'filePath', filePath: 'C:/images/clip.png' }])

    // Plain-text / HTML copy with accompanying image should NOT hijack clipboard text paste
    const htmlBitmap = new File([new Uint8Array([1, 2])], 'image.png', { type: 'image/png' })
    const bitmapGetPath = vi.fn(() => '')
    expect(
      extractClipboardImageSources(
        createDataTransferStub({
          files: [htmlBitmap],
          dataByMime: { 'text/plain': 'copied paragraph text' }
        }),
        { getPathForFile: bitmapGetPath }
      )
    ).toEqual([])
    expect(bitmapGetPath).toHaveBeenCalledTimes(1)

    // Pure bitmap paste via DataTransfer.items fallback (verifying single getPathForFile lookup per file)
    const screenshot = new File([new Uint8Array([9, 8, 7])], 'screenshot.png', { type: 'image/png' })
    const screenshotGetPath = vi.fn(() => '')
    expect(
      extractClipboardImageSources(
        createDataTransferStub({
          items: [{ kind: 'file', getAsFile: () => screenshot }]
        }),
        { getPathForFile: screenshotGetPath }
      )
    ).toEqual([{ kind: 'clipboardFile', file: screenshot, mimeType: 'image/png' }])
    expect(screenshotGetPath).toHaveBeenCalledTimes(1)
  })

  it('inspectDropTransfer distinguishes tab drags, Folder Tree drags, OS file drops, and text drags', () => {
    expect(inspectDropTransfer(null)).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: false,
      isNonImageWorkspaceDrag: false,
      sources: []
    })

    expect(
      inspectDropTransfer(
        createDataTransferStub({ types: [TAB_DRAG_MIME, 'text/plain'] }),
        { draggingWorkspaceImagePaths: ['/ws/pic.png'] }
      )
    ).toEqual({
      isTabDrag: true,
      isWorkspaceOrFileDrag: false,
      isNonImageWorkspaceDrag: false,
      sources: []
    })

    // During Chromium dragover, getData(WORKSPACE_IMAGE_DRAG_MIME) returns '' while types includes MIME
    expect(
      inspectDropTransfer(
        createDataTransferStub({ types: [WORKSPACE_IMAGE_DRAG_MIME] }),
        { draggingWorkspaceImagePaths: ['/ws/hero.png'] }
      )
    ).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: true,
      isNonImageWorkspaceDrag: false,
      sources: [{ kind: 'filePath', filePath: '/ws/hero.png' }]
    })

    // External OS files: resolves path when available, falls back to externalFile bytes, skips non-images
    const nativeImg = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const rawBytesImg = new File([new Uint8Array([2])], 'b.webp', { type: 'image/webp' })
    const txtFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    expect(
      inspectDropTransfer(
        createDataTransferStub({
          types: ['Files'],
          files: [nativeImg, rawBytesImg, txtFile]
        }),
        {
          getPathForFile: (file) => (file === nativeImg ? 'D:/assets/a.png' : '')
        }
      )
    ).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: true,
      isNonImageWorkspaceDrag: false,
      sources: [
        { kind: 'filePath', filePath: 'D:/assets/a.png' },
        { kind: 'externalFile', file: rawBytesImg }
      ]
    })

    // Plain text selection drag is left untouched by image ingestion
    expect(inspectDropTransfer(createDataTransferStub({ types: ['text/plain'] }))).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: false,
      isNonImageWorkspaceDrag: false,
      sources: []
    })

    // Multi-image Folder Tree drag via MIME data and fallback array context state
    expect(
      inspectDropTransfer(
        createDataTransferStub({
          types: [WORKSPACE_ENTRY_DRAG_MIME, WORKSPACE_IMAGE_DRAG_MIME],
          dataByMime: {
            [WORKSPACE_IMAGE_DRAG_MIME]: '/ws/a.png\n/ws/sub/b.webp\n/ws/note.md'
          }
        })
      )
    ).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: true,
      isNonImageWorkspaceDrag: false,
      sources: [
        { kind: 'filePath', filePath: '/ws/a.png' },
        { kind: 'filePath', filePath: '/ws/sub/b.webp' }
      ]
    })

    expect(
      inspectDropTransfer(
        createDataTransferStub({
          types: [WORKSPACE_ENTRY_DRAG_MIME, WORKSPACE_IMAGE_DRAG_MIME]
        }),
        { draggingWorkspaceImagePaths: ['/ws/one.png', '/ws/two.jpg'] }
      )
    ).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: true,
      isNonImageWorkspaceDrag: false,
      sources: [
        { kind: 'filePath', filePath: '/ws/one.png' },
        { kind: 'filePath', filePath: '/ws/two.jpg' }
      ]
    })

    // Non-image Folder Tree drag is recognized as workspace drag with isNonImageWorkspaceDrag=true
    expect(
      inspectDropTransfer(
        createDataTransferStub({
          types: [WORKSPACE_ENTRY_DRAG_MIME],
          dataByMime: { [WORKSPACE_ENTRY_DRAG_MIME]: '/ws/note.md' }
        })
      )
    ).toEqual({
      isTabDrag: false,
      isWorkspaceOrFileDrag: true,
      isNonImageWorkspaceDrag: true,
      sources: []
    })
  })

  it('resolvePendingImageSources dispatches each source sequentially and formatRawMarkdownImages joins paragraphs', async () => {
    const calls: WorkspaceImageIngestInput[] = []
    const ingest = vi.fn(async (input: WorkspaceImageIngestInput): Promise<WorkspaceImageIngestResult> => {
      calls.push(input)
      const n = calls.length
      return {
        markdownPath: `./assets/img-${n}.png`,
        altText: `img-${n}`,
        savedPath: `/ws/docs/assets/img-${n}.png`
      }
    })

    const clipFile = new File([new Uint8Array([10, 20])], 'clip.png', { type: 'image/png' })
    const extFile = new File([new Uint8Array([30, 40])], 'drop.jpg', { type: 'image/jpeg' })

    const results = await resolvePendingImageSources(
      '/ws/docs/page.md',
      [
        { kind: 'filePath', filePath: '/ws/shared/logo.png' },
        { kind: 'clipboardFile', file: clipFile, mimeType: 'image/png' },
        { kind: 'externalFile', file: extFile }
      ],
      ingest
    )

    expect(calls.map((c) => c.source.kind)).toEqual(['filePath', 'clipboard', 'fileBytes'])
    expect(calls[2]?.source.kind === 'fileBytes' ? calls[2].source.fileName : '').toBe('drop.jpg')
    expect(formatRawMarkdownImages(results)).toBe('![img-1](./assets/img-1.png)\n\n![img-2](./assets/img-2.png)\n\n![img-3](./assets/img-3.png)')
  })
})
