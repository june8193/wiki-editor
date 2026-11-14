/// <reference types="vite/client" />

import type { WikiApi } from '@shared/ipc'

declare global {
  interface Window {
    wikiApi: WikiApi
  }
}
