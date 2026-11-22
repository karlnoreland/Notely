/// <reference types="vite/client" />
import type { NotelyApi } from '../../shared/types'

declare global {
  interface Window {
    notely: NotelyApi
  }
}

export {}
