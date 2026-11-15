import { vi } from 'vitest'

export interface RecordedCanvasRasterCall {
  svgDataUri: string
  decodedSvg: string
  pixelWidth: number
  pixelHeight: number
}

export interface SvgCanvasStub {
  calls: RecordedCanvasRasterCall[]
  clearRectSpy: ReturnType<typeof vi.fn>
  drawImageSpy: ReturnType<typeof vi.fn>
  setFailDecode: (fail: boolean) => void
  setEmitNullBlob: (emitNull: boolean) => void
  setDeferLoad: (defer: boolean) => void
  resolveNextLoad: () => void
  restore: () => void
}

/**
 * Installs an isolated JSDOM boundary stub for `globalThis.Image` and offscreen `<canvas>`
 * elements so PNG rasterization flows run end-to-end without OS canvas binaries.
 */
export function installSvgCanvasStub(): SvgCanvasStub {
  const OriginalImage = globalThis.Image
  const origCreateElement = document.createElement.bind(document)

  const calls: RecordedCanvasRasterCall[] = []
  const clearRectSpy = vi.fn()
  const drawImageSpy = vi.fn()
  const pendingLoadCallbacks: Array<() => void> = []

  let shouldFailDecode = false
  let emitNullBlob = false
  let deferLoad = false

  class StubSvgImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    decoding = ''
    private _src = ''

    set src(value: string) {
      this._src = value
      const finish = (): void => {
        if (shouldFailDecode) {
          this.onerror?.()
        } else {
          this.onload?.()
        }
      }
      if (deferLoad) {
        pendingLoadCallbacks.push(finish)
      } else {
        queueMicrotask(finish)
      }
    }

    get src(): string {
      return this._src
    }
  }

  const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    if (tagName.toLowerCase() === 'canvas') {
      let drawnImage: StubSvgImage | null = null
      const canvasMock = {
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect: (...args: unknown[]) => {
            clearRectSpy(...args)
          },
          drawImage: (img: StubSvgImage, ...rest: unknown[]) => {
            drawnImage = img
            drawImageSpy(img, ...rest)
          }
        }),
        toBlob: (callback: (blob: Blob | null) => void) => {
          const svgDataUri = drawnImage?.src ?? ''
          const decodedSvg = svgDataUri.startsWith('data:image/svg+xml;charset=utf-8,')
            ? decodeURIComponent(svgDataUri.slice('data:image/svg+xml;charset=utf-8,'.length))
            : svgDataUri
          calls.push({
            svgDataUri,
            decodedSvg,
            pixelWidth: canvasMock.width,
            pixelHeight: canvasMock.height
          })
          if (emitNullBlob) {
            callback(null)
            return
          }
          const themeByte = decodedSvg.includes('#161b22') ? 2 : 1
          const bytes = new Uint8Array([137, 80, 78, 71, themeByte, canvasMock.width & 0xff])
          callback(new Blob([bytes], { type: 'image/png' }))
        }
      }
      return canvasMock as unknown as HTMLCanvasElement
    }
    return origCreateElement(tagName)
  }) as typeof document.createElement)

  globalThis.Image = StubSvgImage as unknown as typeof Image

  return {
    calls,
    clearRectSpy,
    drawImageSpy,
    setFailDecode: (fail) => {
      shouldFailDecode = fail
    },
    setEmitNullBlob: (emitNull) => {
      emitNullBlob = emitNull
    },
    setDeferLoad: (defer) => {
      deferLoad = defer
    },
    resolveNextLoad: () => {
      const next = pendingLoadCallbacks.shift()
      next?.()
    },
    restore: () => {
      createElementSpy.mockRestore()
      globalThis.Image = OriginalImage
    }
  }
}
