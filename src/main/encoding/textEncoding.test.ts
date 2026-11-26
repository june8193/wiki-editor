import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import {
  decodeTextAuto,
  decodeTextWithEncoding,
  encodeTextWithEncoding,
  findUnencodableCharacters,
  truncateBufferAtCharBoundary,
  UnencodableCharactersError
} from './textEncoding'

describe('textEncoding', () => {
  describe('decodeTextAuto & decodeTextWithEncoding', () => {
    it('detects empty and pure ASCII buffers as utf-8', () => {
      expect(decodeTextAuto(Buffer.alloc(0))).toEqual({ content: '', encoding: 'utf-8' })
      expect(decodeTextAuto(Buffer.from('Hello, wiki!', 'ascii'))).toEqual({
        content: 'Hello, wiki!',
        encoding: 'utf-8'
      })
    })

    it('detects valid UTF-8 Korean and emoji text as utf-8', () => {
      const text = '# 안녕하세요\n위키 에디터 😀'
      const bytes = Buffer.from(text, 'utf8')
      expect(decodeTextAuto(bytes)).toEqual({ content: text, encoding: 'utf-8' })
    })

    it('falls back to CP949 (euc-kr) when strict UTF-8 validation fails', () => {
      const text = '# 한글 제목\nCP949 확장문자: 믜 쀍'
      const cp949Bytes = iconv.encode(text, 'cp949')
      expect(decodeTextAuto(cp949Bytes)).toEqual({ content: text, encoding: 'euc-kr' })
    })

    it('decodes explicitly with utf-8 or euc-kr regardless of auto-detection', () => {
      const asciiBytes = Buffer.from('plain ascii', 'ascii')
      expect(decodeTextWithEncoding(asciiBytes, 'euc-kr')).toBe('plain ascii')

      const cp949Bytes = iconv.encode('한글 테스트', 'cp949')
      expect(decodeTextWithEncoding(cp949Bytes, 'euc-kr')).toBe('한글 테스트')
      expect(decodeTextWithEncoding(cp949Bytes, 'utf-8')).toContain('\uFFFD')
    })
  })

  describe('findUnencodableCharacters & encodeTextWithEncoding', () => {
    it('returns zero unencodable characters for utf-8 and for CP949-compatible text including literal question marks', () => {
      const text = '안녕하세요? 질문이 있습니다? CP949 믜 쀍!'
      expect(findUnencodableCharacters(text, 'utf-8')).toEqual({ count: 0, samples: [] })
      expect(findUnencodableCharacters(text, 'euc-kr')).toEqual({ count: 0, samples: [] })
    })

    it('detects CP949 unencodable characters with count and unique samples while ignoring literal ?', () => {
      const text = '안녕? 😀🚀😀 ✨'
      const result = findUnencodableCharacters(text, 'euc-kr')
      expect(result).toEqual({
        count: 4,
        samples: ['😀', '🚀', '✨']
      })
    })

    it('throws UnencodableCharactersError when encoding euc-kr with unencodable chars unless allowLossy is true', () => {
      const text = '한글? 😀🚀'
      let thrown: unknown
      try {
        encodeTextWithEncoding(text, 'euc-kr')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(UnencodableCharactersError)
      expect((thrown as UnencodableCharactersError).unencodableChars).toEqual({
        count: 2,
        samples: ['😀', '🚀']
      })

      const lossyBytes = encodeTextWithEncoding(text, 'euc-kr', { allowLossy: true })
      expect(iconv.decode(lossyBytes, 'cp949')).toBe('한글? ??')
    })
  })

  describe('truncateBufferAtCharBoundary', () => {
    it('truncates UTF-8 buffers without splitting 3-byte or 4-byte characters', () => {
      const koreanBytes = Buffer.from('가나다', 'utf8') // 9 bytes
      const cut4 = truncateBufferAtCharBoundary(koreanBytes, 4, 'utf-8')
      expect(cut4.toString('utf8')).toBe('가')
      expect(cut4.byteLength).toBe(3)

      const emojiBytes = Buffer.from('a😀b', 'utf8') // 1 + 4 + 1 = 6 bytes
      const cut3 = truncateBufferAtCharBoundary(emojiBytes, 3, 'utf-8')
      expect(cut3.toString('utf8')).toBe('a')
      expect(cut3.byteLength).toBe(1)

      expect(truncateBufferAtCharBoundary(koreanBytes, 0, 'utf-8').byteLength).toBe(0)
      expect(truncateBufferAtCharBoundary(koreanBytes, 9, 'utf-8').toString('utf8')).toBe('가나다')
    })

    it('truncates CP949 buffers without splitting 2-byte characters even when trail bytes are ASCII-range', () => {
      // '믜' in CP949 has an ASCII-range trail byte (0x8D 0x7A or similar); '가' is 0xB0 0xA1
      const cp949Bytes = iconv.encode('믜가', 'cp949') // 4 bytes
      const cut3 = truncateBufferAtCharBoundary(cp949Bytes, 3, 'euc-kr')
      expect(iconv.decode(cut3, 'cp949')).toBe('믜')
      expect(cut3.byteLength).toBe(2)

      const cut1 = truncateBufferAtCharBoundary(cp949Bytes, 1, 'euc-kr')
      expect(cut1.byteLength).toBe(0)
    })

    it('auto-detects UTF-8 vs CP949 when truncating without explicit encoding', () => {
      const utf8Bytes = Buffer.from('가나다', 'utf8')
      expect(decodeTextAuto(truncateBufferAtCharBoundary(utf8Bytes, 5))).toEqual({
        content: '가',
        encoding: 'utf-8'
      })

      const cp949Bytes = iconv.encode('한글테스트', 'cp949')
      expect(decodeTextAuto(truncateBufferAtCharBoundary(cp949Bytes, 5))).toEqual({
        content: '한글',
        encoding: 'euc-kr'
      })
    })
  })
})
