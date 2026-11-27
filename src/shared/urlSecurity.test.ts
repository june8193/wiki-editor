import { describe, expect, it } from 'vitest'
import { normalizeAllowedHttpUrl } from './urlSecurity'

describe('normalizeAllowedHttpUrl', () => {
  it('accepts and trims valid http and https URLs including query strings and hash fragments', () => {
    expect(normalizeAllowedHttpUrl('https://example.com/docs?q=1#section')).toBe(
      'https://example.com/docs?q=1#section'
    )
    expect(normalizeAllowedHttpUrl('  http://localhost:3000/path  ')).toBe(
      'http://localhost:3000/path'
    )
    expect(normalizeAllowedHttpUrl('HTTP://example.com')).toBe('HTTP://example.com')
  })

  it('rejects non-strings, empty strings, and control characters', () => {
    expect(normalizeAllowedHttpUrl(null)).toBeNull()
    expect(normalizeAllowedHttpUrl(undefined)).toBeNull()
    expect(normalizeAllowedHttpUrl(123)).toBeNull()
    expect(normalizeAllowedHttpUrl('')).toBeNull()
    expect(normalizeAllowedHttpUrl('   ')).toBeNull()
    expect(normalizeAllowedHttpUrl('https://example.com\n--evil')).toBeNull()
    expect(normalizeAllowedHttpUrl('https://example.com\u0000')).toBeNull()
    expect(normalizeAllowedHttpUrl('https://example.com/\u001Fpath')).toBeNull()
  })

  it('rejects non-http(s) schemes and relative paths', () => {
    expect(normalizeAllowedHttpUrl('mailto:team@example.com')).toBeNull()
    expect(normalizeAllowedHttpUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeAllowedHttpUrl('file:///C:/Windows/System32/calc.exe')).toBeNull()
    expect(normalizeAllowedHttpUrl('ftp://example.com/file')).toBeNull()
    expect(normalizeAllowedHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(normalizeAllowedHttpUrl('./relative.md')).toBeNull()
    expect(normalizeAllowedHttpUrl('#section')).toBeNull()
  })

  it('rejects malformed http(s) URLs without a valid host', () => {
    expect(normalizeAllowedHttpUrl('https://')).toBeNull()
    expect(normalizeAllowedHttpUrl('http://')).toBeNull()
    expect(normalizeAllowedHttpUrl('http:///path')).toBeNull()
    expect(normalizeAllowedHttpUrl('https://   ')).toBeNull()
  })
})
