export type ApiSettings = {
  baseUrl: string
  hasApiKey: boolean
}

export type ModelInfo = {
  id: string
  ownedBy?: string
}

export type EditProtocol =
  | 'auto'
  | 'openai-images-edits'
  | 'seedream-generations'
  | 'qwen-multimodal'
  | 'chat-completions'

export type UsedEditProtocol = Exclude<EditProtocol, 'auto'>

export type EditRequest = {
  imageDataUrl: string
  fileName: string
  prompt: string
  model: string
  size?: string
  protocol?: EditProtocol
}

export type EditResponse = {
  imageDataUrl: string
  revisedPrompt?: string
  protocol: UsedEditProtocol
}

export type CostDay = {
  date: string
  label: string
  cost: number
  isToday: boolean
}

export type CostSummary = {
  available: boolean
  total: number
  currency: 'CNY'
  exchangeRate: number
  days: CostDay[]
  callCount: number
  tokenBilledCount: number
  requestBilledCount: number
  unpricedCount: number
  weekStart: string
  weekEnd: string
  updatedAt: number
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
