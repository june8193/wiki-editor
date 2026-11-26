export type TextEncoding = 'utf-8' | 'euc-kr'

export const DEFAULT_TEXT_ENCODING: TextEncoding = 'utf-8'

export const TEXT_ENCODING_LABELS: Readonly<Record<TextEncoding, string>> = {
  'utf-8': 'UTF-8',
  'euc-kr': 'EUC-KR'
}

export interface UnencodableCharsInfo {
  count: number
  samples: string[]
}

export interface ReadFileWithEncodingResult {
  content: string
  encoding: TextEncoding
}

export interface WriteFileWithEncodingOptions {
  encoding?: TextEncoding
  allowLossy?: boolean
}

export class UnencodableCharactersError extends Error {
  readonly encoding: TextEncoding
  readonly unencodableChars: UnencodableCharsInfo

  constructor(encoding: TextEncoding, unencodableChars: UnencodableCharsInfo) {
    const samplePreview = unencodableChars.samples.join(' ')
    const label = TEXT_ENCODING_LABELS[encoding]
    super(
      `${label} 인코딩으로 표현할 수 없는 문자 ${unencodableChars.count}개가 포함되어 있습니다` +
        (samplePreview ? `: ${samplePreview}` : '.')
    )
    this.name = 'UnencodableCharactersError'
    this.encoding = encoding
    this.unencodableChars = unencodableChars
  }
}
