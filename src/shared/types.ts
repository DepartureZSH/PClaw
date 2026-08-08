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
}

export type BalanceInfo = {
  available: boolean
  amount?: number
  used?: number
  unit?: string
  message?: string
}
