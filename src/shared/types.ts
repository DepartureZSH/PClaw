export type ApiSettings = {
  baseUrl: string
  hasApiKey: boolean
}

export type ModelInfo = {
  id: string
  ownedBy?: string
}

export type EditRequest = {
  imageDataUrl: string
  fileName: string
  prompt: string
  model: string
  size?: string
}

export type EditResponse = {
  imageDataUrl: string
  revisedPrompt?: string
  protocol: 'images-edits' | 'chat-completions'
}

export type BalanceInfo = {
  available: boolean
  amount?: number
  used?: number
  unit?: string
  message?: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export type LogEntry = {
  id: string
  timestamp: string
  level: LogLevel
  event: string
  message: string
  details?: Record<string, string | number | boolean | null>
}
