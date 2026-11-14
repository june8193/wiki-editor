export interface AsyncQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>
  flush(): Promise<void>
}

/**
 * Creates a FIFO promise chain that serializes async tasks without stalling on prior rejections.
 */
export function createAsyncQueue(): AsyncQueue {
  let tail: Promise<void> = Promise.resolve()

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task)
      tail = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
    flush(): Promise<void> {
      return tail
    }
  }
}
