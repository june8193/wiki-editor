import { useState } from 'react'
import { buildWikiAssetUrl } from '@shared/assets'

interface ImagePreviewProps {
  path: string
  name: string
  cacheKey?: string | number
}

/**
 * Renders a centered, responsive read-only image preview backed by the `wiki-asset:` protocol.
 */
export function ImagePreview({ path, name, cacheKey }: ImagePreviewProps) {
  const src = buildWikiAssetUrl(path, cacheKey)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const hasError = failedSrc === src

  return (
    <section
      className="image-preview"
      data-testid="image-preview"
      aria-label="이미지 미리보기"
      tabIndex={0}
    >
      {hasError ? (
        <p className="image-preview-error" role="status">
          이미지를 불러올 수 없습니다.
        </p>
      ) : (
        <img
          className="image-preview-img"
          src={src}
          alt={name}
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      )}
    </section>
  )
}
