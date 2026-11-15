import {
  formatMarkdownImage,
  getImageMimeType,
  isSupportedImageFile,
  isSupportedImageMimeType,
  type WorkspaceImageIngestInput,
  type WorkspaceImageIngestResult
} from '@shared/assets'

export const TAB_DRAG_MIME = 'application/x-wiki-tab'
export const WORKSPACE_IMAGE_DRAG_MIME = 'application/x-wiki-workspace-image'

export type ImageIngestor = (
  input: WorkspaceImageIngestInput
) => Promise<WorkspaceImageIngestResult>

export type PendingImageSource =
  | { kind: 'filePath'; filePath: string }
  | { kind: 'clipboardFile'; file: File; mimeType: string }
  | { kind: 'externalFile'; file: File }

export interface ImageTransferInspectOptions {
  getPathForFile?: (file: File) => string
  draggingWorkspaceImagePath?: string | null
}

export interface InspectedDropTransfer {
  isTabDrag: boolean
  isWorkspaceOrFileDrag: boolean
  sources: PendingImageSource[]
}

function resolveGetPathForFile(override?: (file: File) => string): ((file: File) => string) | undefined {
  if (override) {
    return override
  }
  const workspaceApi = typeof window !== 'undefined' ? window.wikiApi?.workspace : undefined
  if (workspaceApi && typeof workspaceApi.getPathForFile === 'function') {
    return (file) => workspaceApi.getPathForFile(file)
  }
  return undefined
}

function resolveIngestor(override?: ImageIngestor): ImageIngestor {
  if (override) {
    return override
  }
  const workspaceApi = typeof window !== 'undefined' ? window.wikiApi?.workspace : undefined
  if (workspaceApi && typeof workspaceApi.ingestImage === 'function') {
    return (input) => workspaceApi.ingestImage(input)
  }
  throw new Error('이미지 수집 API를 사용할 수 없습니다.')
}

async function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }
  return new Uint8Array(await new Response(file).arrayBuffer())
}

function collectClipboardFiles(clipboardData: DataTransfer): File[] {
  const directFiles = Array.from(clipboardData.files ?? [])
  if (directFiles.length > 0) {
    return directFiles
  }

  const itemFiles: File[] = []
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file') {
      continue
    }
    const file = item.getAsFile()
    if (file) {
      itemFiles.push(file)
    }
  }
  return itemFiles
}

/**
 * Extracts image ingestion sources from clipboard paste data.
 * Copied OS image files always ingest; bitmap screenshots only ingest when `text/plain` is empty.
 */
export function extractClipboardImageSources(
  clipboardData: DataTransfer | null,
  options: Pick<ImageTransferInspectOptions, 'getPathForFile'> = {}
): PendingImageSource[] {
  if (!clipboardData) {
    return []
  }

  const getPathForFile = resolveGetPathForFile(options.getPathForFile)
  const files = collectClipboardFiles(clipboardData)

  const pathBackedImages: PendingImageSource[] = []
  for (const file of files) {
    const nativePath = getPathForFile?.(file) ?? ''
    if (nativePath && isSupportedImageFile(nativePath)) {
      pathBackedImages.push({ kind: 'filePath', filePath: nativePath })
    }
  }
  if (pathBackedImages.length > 0) {
    return pathBackedImages
  }

  const plainText = clipboardData.getData('text/plain')
  if (plainText.length > 0) {
    return []
  }

  const bitmapSources: PendingImageSource[] = []
  for (const file of files) {
    const nativePath = getPathForFile?.(file) ?? ''
    if (nativePath && !isSupportedImageFile(nativePath)) {
      continue
    }
    const mimeType = isSupportedImageMimeType(file.type)
      ? file.type
      : (getImageMimeType(file.name) ?? '')
    if (mimeType && isSupportedImageMimeType(mimeType)) {
      bitmapSources.push({ kind: 'clipboardFile', file, mimeType })
    }
  }
  return bitmapSources
}

/**
 * Inspects a dragover/drop DataTransfer synchronously for tab drags, workspace tree images, or OS files.
 */
export function inspectDropTransfer(
  dataTransfer: DataTransfer | null,
  options: ImageTransferInspectOptions = {}
): InspectedDropTransfer {
  if (!dataTransfer) {
    return { isTabDrag: false, isWorkspaceOrFileDrag: false, sources: [] }
  }

  const types = Array.from(dataTransfer.types ?? [])
  if (types.includes(TAB_DRAG_MIME)) {
    return { isTabDrag: true, isWorkspaceOrFileDrag: false, sources: [] }
  }

  const files = Array.from(dataTransfer.files ?? [])
  const hasExplicitWorkspaceMime = types.includes(WORKSPACE_IMAGE_DRAG_MIME)
  const rawWorkspaceMimeData = dataTransfer.getData(WORKSPACE_IMAGE_DRAG_MIME)
  const fallbackWorkspacePath =
    files.length === 0 && (types.length === 0 || hasExplicitWorkspaceMime)
      ? (options.draggingWorkspaceImagePath ?? '')
      : ''
  const workspaceImagePath = rawWorkspaceMimeData || fallbackWorkspacePath

  const isWorkspaceOrFileDrag =
    hasExplicitWorkspaceMime ||
    Boolean(workspaceImagePath) ||
    types.includes('Files') ||
    files.length > 0

  if (!isWorkspaceOrFileDrag) {
    return { isTabDrag: false, isWorkspaceOrFileDrag: false, sources: [] }
  }

  const sources: PendingImageSource[] = []
  if (workspaceImagePath && isSupportedImageFile(workspaceImagePath)) {
    sources.push({ kind: 'filePath', filePath: workspaceImagePath })
  }

  const getPathForFile = resolveGetPathForFile(options.getPathForFile)
  for (const file of files) {
    const nativePath = getPathForFile?.(file) ?? ''
    if (nativePath) {
      if (isSupportedImageFile(nativePath)) {
        sources.push({ kind: 'filePath', filePath: nativePath })
      }
      continue
    }
    if (isSupportedImageMimeType(file.type) || isSupportedImageFile(file.name)) {
      sources.push({ kind: 'externalFile', file })
    }
  }

  return {
    isTabDrag: false,
    isWorkspaceOrFileDrag: true,
    sources
  }
}

/**
 * Resolves captured synchronous image sources sequentially through the workspace ingestion API.
 */
export async function resolvePendingImageSources(
  documentPath: string,
  sources: readonly PendingImageSource[],
  ingestImageOverride?: ImageIngestor
): Promise<WorkspaceImageIngestResult[]> {
  const ingest = resolveIngestor(ingestImageOverride)
  const results: WorkspaceImageIngestResult[] = []

  for (const item of sources) {
    if (item.kind === 'filePath') {
      results.push(
        await ingest({
          documentPath,
          source: { kind: 'filePath', filePath: item.filePath }
        })
      )
      continue
    }

    const bytes = await readFileAsUint8Array(item.file)
    if (item.kind === 'clipboardFile') {
      results.push(
        await ingest({
          documentPath,
          source: { kind: 'clipboard', bytes, mimeType: item.mimeType }
        })
      )
      continue
    }

    results.push(
      await ingest({
        documentPath,
        source: { kind: 'fileBytes', fileName: item.file.name, bytes }
      })
    )
  }

  return results
}

/**
 * Formats one or more ingested images as newline-separated Markdown paragraphs.
 */
export function formatRawMarkdownImages(images: readonly WorkspaceImageIngestResult[]): string {
  return images.map((image) => formatMarkdownImage(image)).join('\n\n')
}
