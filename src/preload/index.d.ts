import type { DesktopApi } from './index'

declare global {
  interface Window {
    pclaw: DesktopApi
  }
}

export {}
