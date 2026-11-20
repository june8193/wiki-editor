import { type RefObject, useEffect, useRef } from 'react'
import type { SearchFocusRequest } from '../utils/workspaceSearch'

/**
 * Focuses (and optionally selects all text in) a search input once per focusRequest nonce.
 */
export function useSearchInputFocus(
  focusRequest: SearchFocusRequest | null,
  onConsumeFocusNonce?: (nonce: number) => boolean
): RefObject<HTMLInputElement | null> {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lastHandledFocusNonceRef = useRef(0)

  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === 0) return
    if (focusRequest.nonce === lastHandledFocusNonceRef.current) return
    if (onConsumeFocusNonce && !onConsumeFocusNonce(focusRequest.nonce)) {
      lastHandledFocusNonceRef.current = focusRequest.nonce
      return
    }
    lastHandledFocusNonceRef.current = focusRequest.nonce

    const input = inputRef.current
    if (!input) return
    input.focus()
    if (focusRequest.selectAll && input.value.length > 0) {
      input.select()
    }
  }, [focusRequest, onConsumeFocusNonce])

  return inputRef
}
