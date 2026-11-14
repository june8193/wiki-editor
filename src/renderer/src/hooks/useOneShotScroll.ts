import { useEffect, useRef } from 'react'

/**
 * Executes a nonce-keyed scroll command at most once per nonce once `isReady` is true,
 * preventing redundant prop updates from re-triggering the scroll.
 */
export function useOneShotScroll<T extends { nonce: number }>(
  request: T | null | undefined,
  isReady: boolean,
  execute: (request: T) => boolean | void
): void {
  const handledNonceRef = useRef<number | null>(null)
  const executeRef = useRef(execute)
  executeRef.current = execute

  useEffect(() => {
    if (!request || !isReady) return
    if (handledNonceRef.current === request.nonce) return
    if (executeRef.current(request) !== false) {
      handledNonceRef.current = request.nonce
    }
  }, [isReady, request])
}
