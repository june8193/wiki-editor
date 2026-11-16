import { useCallback, useEffect, useRef, useState } from 'react'

export const ACTION_FEEDBACK_DURATION_MS = 1500

export interface TimedFeedbackState<T> {
  completedKey: T | null
  triggerFeedback: (key: T) => void
  clearFeedback: () => void
  beginExecution: () => number
  isExecutionActive: (token: number) => boolean
}

/**
 * Tracks a temporary action-completion feedback badge and async execution token
 * with unmount, dependency-reset, and overlapping-timer guards.
 */
export function useTimedFeedback<T>(
  resetDeps: readonly unknown[] = [],
  durationMs = ACTION_FEEDBACK_DURATION_MS
): TimedFeedbackState<T> {
  const [completedKey, setCompletedKey] = useState<T | null>(null)
  const isMountedRef = useRef(true)
  const timerRef = useRef<number | null>(null)
  const feedbackTokenRef = useRef(0)
  const executionTokenRef = useRef(0)
  const previousResetDepsRef = useRef<readonly unknown[]>(resetDeps)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const clearFeedback = useCallback(() => {
    feedbackTokenRef.current += 1
    executionTokenRef.current += 1
    clearTimer()
    if (isMountedRef.current) {
      setCompletedKey(null)
    }
  }, [clearTimer])

  const beginExecution = useCallback((): number => {
    clearFeedback()
    return executionTokenRef.current
  }, [clearFeedback])

  const isExecutionActive = useCallback(
    (token: number): boolean => isMountedRef.current && executionTokenRef.current === token,
    []
  )

  const triggerFeedback = useCallback(
    (key: T) => {
      if (!isMountedRef.current) return
      const token = ++feedbackTokenRef.current
      clearTimer()
      setCompletedKey(key)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (!isMountedRef.current || feedbackTokenRef.current !== token) {
          return
        }
        setCompletedKey(null)
      }, durationMs)
    },
    [clearTimer, durationMs]
  )

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      feedbackTokenRef.current += 1
      executionTokenRef.current += 1
      clearTimer()
    }
  }, [clearTimer])

  useEffect(() => {
    const prev = previousResetDepsRef.current
    const unchanged =
      prev.length === resetDeps.length &&
      resetDeps.every((dep, index) => Object.is(prev[index], dep))
    if (unchanged) {
      return
    }
    previousResetDepsRef.current = resetDeps
    clearFeedback()
  })

  return {
    completedKey,
    triggerFeedback,
    clearFeedback,
    beginExecution,
    isExecutionActive
  }
}
