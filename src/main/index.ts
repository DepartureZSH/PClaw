import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { join, extname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import Store from 'electron-store'
import type {
  ApiSettings,
  CostDay,
  CostSummary,
  EditRequest,
  EditResponse,
  ModelInfo,
  UsedEditProtocol
} from '../shared/types'
import { clearLogs, formatLogs, listLogs, writeLog } from './logger'

type SettingsStore = {
  baseUrl: string
  encryptedApiKey?: string
}

const store = new Store<SettingsStore>({
  name: 'settings',
  defaults: { baseUrl: 'https://chatbot.cn.unreachablecity.club' }
})

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly status: number,
    readonly requestId?: string,
    readonly responseBody?: string
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

function normalizeBaseUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!/^https?:\/\//i.test(normalized)) throw new Error('API 地址必须以 http:// 或 https:// 开头')
  return normalized
}

function getApiKey(): string {
  const encrypted = store.get('encryptedApiKey')
  if (!encrypted) return ''
  try {
    const raw = Buffer.from(encrypted, 'base64')
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch {
    return ''
  }
}

function saveApiKey(apiKey: string): void {
  const raw = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(apiKey.trim())
    : Buffer.from(apiKey.trim(), 'utf8')
  store.set('encryptedApiKey', raw.toString('base64'))
}

function settings(): ApiSettings {
  return { baseUrl: store.get('baseUrl'), hasApiKey: Boolean(getApiKey()) }
}

async function apiFetch(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
  const apiKey = getApiKey()
  if (authenticated && !apiKey) throw new Error('请先在设置中填写 New API Key')
  let response: Response
  try {
    response = await fetch(`${normalizeBaseUrl(store.get('baseUrl'))}${path}`, {
      ...init,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...init.headers
      }
    })
  } catch (error) {
    throw new ApiRequestError(
      `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
      path,
      0
    )
  }
  if (!response.ok) {
    const body = await response.text()
    let message = `请求失败 (${response.status})`
    try {
      const parsed = JSON.parse(body)
      message = parsed.error?.message || parsed.message || message
    } catch {
      if (body.trim()) message = body.slice(0, 300)
    }
    const requestId = response.headers.get('x-oneapi-request-id')
      || response.headers.get('x-request-id')
      || response.headers.get('request-id')
      || undefined
    throw new ApiRequestError(message, path, response.status, requestId, body.slice(0, 1000))
  }
  return response
}

type PricingItem = {
  model_name?: string
  quota_type?: number | string
  model_ratio?: number | string
  model_price?: number | string
  completion_ratio?: number | string
}

type TokenLog = {
  created_at?: number | string
  type?: number | string
  model_name?: string
  prompt_tokens?: number | string
  completion_tokens?: number | string
  group?: string
}

const QUOTA_PER_USD = 500_000
const COST_MARKUP = 1.1
const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function currentWeek(now = new Date()): { start: Date; end: Date; days: CostDay[] } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  const today = localDateKey(now)
  const days = DAY_LABELS.map((label, index) => {
    const date = new Date(start)
    date.setDate(date.getDate() + index)
    const key = localDateKey(date)
    return { date: key, label, cost: 0, isToday: key === today }
  })
  return { start, end, days }
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function fetchCostSummary(): Promise<CostSummary> {
  const now = new Date()
  const week = currentWeek(now)
  const emptyResult = (message?: string): CostSummary => ({
    available: false,
    total: 0,
    currency: 'USD',
    days: week.days,
    callCount: 0,
    tokenBilledCount: 0,
    requestBilledCount: 0,
    unpricedCount: 0,
    weekStart: localDateKey(week.start),
    weekEnd: localDateKey(week.end),
    updatedAt: Date.now(),
    message
  })

  try {
    const [pricingResponse, logsResponse] = await Promise.all([
      apiFetch('/api/pricing', {}, false),
      apiFetch('/api/log/token')
    ])
    const pricingBody = (await pricingResponse.json()) as Record<string, unknown>
    const logsBody = (await logsResponse.json()) as Record<string, unknown>
    const pricingItems = Array.isArray(pricingBody.data) ? pricingBody.data as PricingItem[] : []
    if (pricingBody.success === false || pricingItems.length === 0) {
      throw new Error(typeof pricingBody.message === 'string' ? pricingBody.message : 'New API 未返回可用模型价格')
    }
    const rawLogData = logsBody.data
    if (logsBody.success === false || !Array.isArray(rawLogData)) {
      throw new Error(typeof logsBody.message === 'string' ? logsBody.message : 'New API 未返回当前令牌消费日志')
    }
    const logs = Array.isArray(rawLogData)
      ? rawLogData as TokenLog[]
      : []
    const rawGroupRatios = pricingBody.group_ratio && typeof pricingBody.group_ratio === 'object'
      ? pricingBody.group_ratio as Record<string, unknown>
      : {}
    const groupRatios = new Map(Object.entries(rawGroupRatios).map(([group, ratio]) => [group, numberValue(ratio, NaN)]))
    const pricingByModel = new Map(pricingItems
      .filter((item) => typeof item.model_name === 'string')
      .map((item) => [item.model_name as string, item]))
    const dayByDate = new Map(week.days.map((day) => [day.date, day]))
    let total = 0
    let callCount = 0
    let tokenBilledCount = 0
    let requestBilledCount = 0
    let unpricedCount = 0

    for (const log of logs) {
      const createdAt = numberValue(log.created_at)
      const createdDate = new Date(createdAt > 10_000_000_000 ? createdAt : createdAt * 1000)
      if (!Number.isFinite(createdDate.getTime()) || createdDate < week.start || createdDate > week.end) continue
      if (log.type !== undefined && numberValue(log.type) !== 2) continue
      callCount += 1
      const price = pricingByModel.get(log.model_name || '')
      const group = log.group || 'default'
      const groupRatio = groupRatios.get(group)
      if (!price || !Number.isFinite(groupRatio)) {
        unpricedCount += 1
        continue
      }

      const quotaType = numberValue(price.quota_type, NaN)
      let cost = NaN
      if (quotaType === 1) {
        cost = numberValue(price.model_price, NaN) * groupRatio * COST_MARKUP
        requestBilledCount += Number.isFinite(cost) ? 1 : 0
      } else if (quotaType === 0) {
        const modelRatio = numberValue(price.model_ratio, NaN)
        const completionRatio = numberValue(price.completion_ratio, NaN)
        const inputTokens = numberValue(log.prompt_tokens)
        const outputTokens = numberValue(log.completion_tokens)
        cost = (
          inputTokens * modelRatio * groupRatio / QUOTA_PER_USD
          + outputTokens * modelRatio * completionRatio * groupRatio / QUOTA_PER_USD
        ) * COST_MARKUP
        tokenBilledCount += Number.isFinite(cost) ? 1 : 0
      }
      if (!Number.isFinite(cost) || cost < 0) {
        unpricedCount += 1
        continue
      }
      total += cost
      const bucket = dayByDate.get(localDateKey(createdDate))
      if (bucket) bucket.cost += cost
    }

    const result: CostSummary = {
      ...emptyResult(),
      available: true,
      total,
      callCount,
      tokenBilledCount,
      requestBilledCount,
      unpricedCount,
      message: unpricedCount > 0 ? `${unpricedCount} 次调用缺少模型或分组价格，未计入` : undefined
    }
    writeLog('info', 'api.cost', '本周成本统计获取成功', {
      total: Number(total.toFixed(6)),
      callCount,
      tokenBilledCount,
      requestBilledCount,
      unpricedCount
    })
    return result
  } catch (error) {
    writeLog('warn', 'api.cost.unavailable', errorMessage(error), errorDetails(error))
    return emptyResult('成本统计暂不可用，请查看运行日志')
  }
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('图片数据格式无效')
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof ApiRequestError)) return {}
  return {
    endpoint: error.path,
    status: error.status,
    requestId: error.requestId || null,
    responsePreview: error.responseBody
      ? error.responseBody
        .replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[image data hidden]')
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[API key hidden]')
        .slice(0, 500)
      : null
  }
}

function inferEditProtocol(model: string): UsedEditProtocol {
  if (/seedream|seededit/i.test(model)) return 'seedream-generations'
  if (/qwen[-_.]?(image|image-edit)|wanx/i.test(model)) return 'qwen-multimodal'
  if (/gemini|banana/i.test(model)) return 'chat-completions'
  return 'openai-images-edits'
}

function findImageSource(value: unknown, key = ''): string | undefined {
  if (typeof value === 'string') {
    const dataUrl = value.match(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/)?.[0]
    if (dataUrl) return dataUrl.replace(/\s/g, '')
    if (key === 'b64_json' && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
      return `data:image/png;base64,${value.replace(/\s/g, '')}`
    }
    if (/url|image/i.test(key) && /^https?:\/\//i.test(value)) return value
    const markdownImage = value.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/i)?.[1]
    if (markdownImage) return markdownImage
    return undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageSource(item, key)
      if (found) return found
    }
    return undefined
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const prioritized = entries.sort(([a], [b]) => {
      const score = (name: string) => /b64_json/i.test(name) ? 0 : /image|url/i.test(name) ? 1 : 2
      return score(a) - score(b)
    })
    for (const [childKey, child] of prioritized) {
      const found = findImageSource(child, childKey)
      if (found) return found
    }
  }
  return undefined
}

async function imageSourceToDataUrl(source: string): Promise<string> {
  if (source.startsWith('data:image/')) return source
  const imageResponse = await fetch(source)
  if (!imageResponse.ok) throw new Error(`无法下载模型返回的图片 (${imageResponse.status})`)
  const contentType = imageResponse.headers.get('content-type') || 'image/png'
  if (!contentType.startsWith('image/')) throw new Error(`模型返回地址不是图片 (${contentType})`)
  const resultBuffer = Buffer.from(await imageResponse.arrayBuffer())
  return `data:${contentType};base64,${resultBuffer.toString('base64')}`
}

async function parseImageResponse(response: Response, protocol: UsedEditProtocol): Promise<EditResponse> {
  const body = (await response.json()) as Record<string, unknown>
  const source = findImageSource(body)
  if (!source) throw new Error('图片接口成功返回，但响应中没有可识别的图片')
  const item = Array.isArray(body.data) ? body.data[0] as Record<string, unknown> | undefined : undefined
  return {
    imageDataUrl: await imageSourceToDataUrl(source),
    revisedPrompt: typeof item?.revised_prompt === 'string' ? item.revised_prompt : undefined,
    protocol
  }
}

async function editWithOpenAiImagesApi(request: EditRequest): Promise<EditResponse> {
  const { buffer, mime } = dataUrlToBuffer(request.imageDataUrl)
  const form = new FormData()
  form.append('image', new Blob([buffer], { type: mime }), request.fileName || 'image.png')
  form.append('prompt', request.prompt)
  form.append('model', request.model)
  if (request.size && request.size !== 'auto') form.append('size', request.size)
  form.append('response_format', 'b64_json')

  const response = await apiFetch('/v1/images/edits', { method: 'POST', body: form })
  return parseImageResponse(response, 'openai-images-edits')
}

async function editWithSeedreamApi(request: EditRequest): Promise<EditResponse> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    image: [request.imageDataUrl],
    response_format: 'b64_json',
    watermark: false
  }
  if (request.size && request.size !== 'auto') body.size = request.size

  const response = await apiFetch('/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return parseImageResponse(response, 'seedream-generations')
}

async function editWithQwenApi(request: EditRequest): Promise<EditResponse> {
  const parameters: Record<string, unknown> = { n: 1, watermark: false }
  if (request.size && request.size !== 'auto') parameters.size = request.size.replace('x', '*')

  const response = await apiFetch('/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      response_format: 'b64_json',
      input: {
        messages: [{
          role: 'user',
          content: [
            { image: request.imageDataUrl },
            { text: request.prompt }
          ]
        }]
      },
      parameters
    })
  })
  return parseImageResponse(response, 'qwen-multimodal')
}

async function editWithChatApi(request: EditRequest): Promise<EditResponse> {
  const response = await apiFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          { type: 'image_url', image_url: { url: request.imageDataUrl } }
        ]
      }],
      modalities: ['text', 'image'],
      stream: false
    })
  })
  const body = (await response.json()) as Record<string, unknown>
  const source = findImageSource(body)
  if (!source) throw new Error('多模态接口成功返回，但响应中没有可识别的图片；请确认该模型支持图片输出')
  return {
    imageDataUrl: await imageSourceToDataUrl(source),
    protocol: 'chat-completions'
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings())
  ipcMain.handle('settings:save', (_event, value: { baseUrl: string; apiKey?: string }) => {
    store.set('baseUrl', normalizeBaseUrl(value.baseUrl))
    if (value.apiKey?.trim()) saveApiKey(value.apiKey)
    writeLog('info', 'settings.saved', 'New API 连接设置已更新', { baseUrl: normalizeBaseUrl(value.baseUrl), apiKeyChanged: Boolean(value.apiKey?.trim()) })
    return settings()
  })

  ipcMain.handle('logs:list', () => listLogs())
  ipcMain.handle('logs:clear', () => {
    clearLogs()
    writeLog('info', 'logs.cleared', '运行日志已清空')
    return listLogs()
  })
  ipcMain.handle('logs:export', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出 PClaw 运行日志',
      defaultPath: `PClaw-logs-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: '文本日志', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, formatLogs(), 'utf8')
    writeLog('info', 'logs.exported', '运行日志已导出', { filePath: result.filePath })
    return result.filePath
  })
  ipcMain.on('logs:renderer-error', (_event, value: { message?: string; source?: string }) => {
    writeLog('error', 'renderer.error', value.message || 'Renderer 未知错误', { source: value.source || null })
  })

  ipcMain.handle('file:open-image', async () => {
    const result = await dialog.showOpenDialog({
      title: '打开图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const buffer = await readFile(filePath)
    const extension = extname(filePath).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, fileName: filePath.split(/[\\/]/).pop() || 'image.png' }
  })

  ipcMain.handle('file:save-image', async (_event, dataUrl: string, suggestedName: string) => {
    const { buffer, mime } = dataUrlToBuffer(dataUrl)
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
    const result = await dialog.showSaveDialog({
      title: '另存图片',
      defaultPath: suggestedName.replace(/\.[^.]+$/, '') + `.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, buffer)
    return result.filePath
  })

  ipcMain.handle('api:models', async (): Promise<ModelInfo[]> => {
    try {
      const response = await apiFetch('/v1/models')
      const body = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> }
      const models = (body.data || []).map((item) => ({ id: item.id, ownedBy: item.owned_by }))
      writeLog('info', 'api.models', '模型列表获取成功', { count: models.length })
      return models
    } catch (error) {
      writeLog('error', 'api.models.error', errorMessage(error), errorDetails(error))
      throw error
    }
  })

  ipcMain.handle('api:cost', fetchCostSummary)

  ipcMain.handle('api:edit-image', async (_event, request: EditRequest): Promise<EditResponse> => {
    const requestedProtocol = request.protocol || 'auto'
    const protocol: UsedEditProtocol = requestedProtocol === 'auto'
      ? inferEditProtocol(request.model)
      : requestedProtocol
    const handlers: Record<UsedEditProtocol, (value: EditRequest) => Promise<EditResponse>> = {
      'openai-images-edits': editWithOpenAiImagesApi,
      'seedream-generations': editWithSeedreamApi,
      'qwen-multimodal': editWithQwenApi,
      'chat-completions': editWithChatApi
    }

    writeLog('info', 'image.edit.started', '开始 AI 图片编辑', {
      model: request.model,
      fileName: request.fileName,
      size: request.size || 'auto',
      promptLength: request.prompt.length,
      requestedProtocol,
      resolvedProtocol: protocol
    })

    try {
      const result = await handlers[protocol](request)
      writeLog('info', 'image.edit.completed', 'AI 图片编辑成功', { model: request.model, protocol })
      return result
    } catch (error) {
      writeLog('error', 'image.edit.failed', errorMessage(error), {
        model: request.model,
        protocol,
        ...errorDetails(error)
      })
      const requestId = error instanceof ApiRequestError && error.requestId ? `（请求 ID：${error.requestId}）` : ''
      throw new Error(`${errorMessage(error)}${requestId}。当前协议：${protocol}，详情已写入运行日志。`)
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#10110f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    writeLog('error', 'renderer.gone', 'Renderer 进程异常退出', { reason: details.reason, exitCode: details.exitCode })
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  writeLog('info', 'app.started', 'PClaw 已启动', { version: app.getVersion(), platform: process.platform })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  writeLog('error', 'process.uncaught', error.message, { stack: error.stack || null })
})

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'process.rejection', errorMessage(reason))
})
