import iconv from 'iconv-lite'
import {
  type ReadFileWithEncodingResult,
  type TextEncoding,
  type UnencodableCharsInfo,
  UnencodableCharactersError
} from '@shared/encoding'

export { UnencodableCharactersError }

const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const LOSSY_UTF8_DECODER = new TextDecoder('utf-8', { fatal: false })

function toBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Decodes raw bytes by trying strict UTF-8 validation first and falling back to CP949 (`euc-kr`).
 */
export function decodeTextAuto(bytes: Uint8Array | Buffer): ReadFileWithEncodingResult {
  if (bytes.byteLength === 0) {
    return { content: '', encoding: 'utf-8' }
  }
  try {
    return {
      content: STRICT_UTF8_DECODER.decode(bytes),
      encoding: 'utf-8'
    }
  } catch {
    return {
      content: iconv.decode(toBuffer(bytes), 'cp949'),
      encoding: 'euc-kr'
    }
  }
}

/**
 * Decodes raw bytes using an explicitly requested text encoding.
 */
export function decodeTextWithEncoding(bytes: Uint8Array | Buffer, encoding: TextEncoding): string {
  if (encoding === 'euc-kr') {
    return iconv.decode(toBuffer(bytes), 'cp949')
  }
  return LOSSY_UTF8_DECODER.decode(bytes)
}

const DEFAULT_UNENCODABLE_SAMPLE_LIMIT = 5

/**
 * Inspects `text` for characters that cannot be represented in `encoding` (CP949 for `euc-kr`),
 * distinguishing literal `?` from replacement characters.
 */
export function findUnencodableCharacters(
  text: string,
  encoding: TextEncoding,
  maxSamples = DEFAULT_UNENCODABLE_SAMPLE_LIMIT
): UnencodableCharsInfo {
  if (encoding === 'utf-8' || text.length === 0) {
    return { count: 0, samples: [] }
  }

  const encoded = iconv.encode(text, 'cp949')
  if (iconv.decode(encoded, 'cp949') === text) {
    return { count: 0, samples: [] }
  }

  let count = 0
  const samples: string[] = []
  const seenSamples = new Set<string>()
  const encodableCache = new Map<string, boolean>()

  for (const ch of text) {
    let encodable = encodableCache.get(ch)
    if (encodable === undefined) {
      if (ch === '?') {
        encodable = true
      } else {
        const roundTripped = iconv.decode(iconv.encode(ch, 'cp949'), 'cp949')
        encodable = roundTripped === ch
      }
      encodableCache.set(ch, encodable)
    }

    if (!encodable) {
      count += 1
      if (samples.length < maxSamples && !seenSamples.has(ch)) {
        seenSamples.add(ch)
        samples.push(ch)
      }
    }
  }

  return { count, samples }
}

/**
 * Encodes `text` into `encoding`, throwing `UnencodableCharactersError` when characters cannot be
 * represented unless `allowLossy` is explicitly `true`.
 */
export function encodeTextWithEncoding(
  text: string,
  encoding: TextEncoding,
  options: { allowLossy?: boolean } = {}
): Buffer {
  if (encoding === 'utf-8') {
    return Buffer.from(text, 'utf8')
  }

  const unencodable = findUnencodableCharacters(text, 'euc-kr')
  if (unencodable.count > 0 && !options.allowLossy) {
    throw new UnencodableCharactersError('euc-kr', unencodable)
  }

  return iconv.encode(text, 'cp949')
}

function getUtf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1
  if ((leadByte & 0xe0) === 0xc0) return 2
  if ((leadByte & 0xf0) === 0xe0) return 3
  if ((leadByte & 0xf8) === 0xf0) return 4
  return 1
}

function findUtf8BoundaryEnd(buffer: Buffer, maxBytes: number): number {
  let leadIndex = maxBytes - 1
  let steps = 0
  while (leadIndex > 0 && (buffer[leadIndex] & 0xc0) === 0x80 && steps < 3) {
    leadIndex -= 1
    steps += 1
  }
  const seqLen = getUtf8SequenceLength(buffer[leadIndex])
  return leadIndex + seqLen > maxBytes ? leadIndex : maxBytes
}

function findCp949BoundaryEnd(buffer: Buffer, maxBytes: number): number {
  const lastNewline = buffer.lastIndexOf(0x0a, maxBytes - 1)
  let index = lastNewline >= 0 ? lastNewline + 1 : 0

  while (index < maxBytes) {
    const byte = buffer[index]
    const charLen = byte >= 0x81 && byte <= 0xfe && index + 1 < buffer.length ? 2 : 1
    if (index + charLen > maxBytes) {
      return index
    }
    index += charLen
  }

  return maxBytes
}

function isStrictUtf8(bytes: Uint8Array | Buffer): boolean {
  try {
    STRICT_UTF8_DECODER.decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Truncates `buffer` to at most `maxBytes` without splitting a multibyte UTF-8 or CP949 character.
 */
export function truncateBufferAtCharBoundary(
  buffer: Buffer,
  maxBytes: number,
  encoding: TextEncoding | 'auto' = 'auto'
): Buffer {
  if (maxBytes <= 0) {
    return buffer.subarray(0, 0)
  }
  if (buffer.byteLength <= maxBytes) {
    return buffer
  }

  const resolvedEncoding: TextEncoding =
    encoding === 'auto' ? (isStrictUtf8(buffer) ? 'utf-8' : 'euc-kr') : encoding

  const safeEnd =
    resolvedEncoding === 'utf-8'
      ? findUtf8BoundaryEnd(buffer, maxBytes)
      : findCp949BoundaryEnd(buffer, maxBytes)

  return buffer.subarray(0, safeEnd)
}
