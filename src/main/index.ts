import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { join, extname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import Store from 'electron-store'
import type { ApiSettings, BalanceInfo, EditRequest, EditResponse, ModelInfo } from '../shared/types'
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

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('请先在设置中填写 New API Key')
  let response: Response
  try {
    response = await fetch(`${normalizeBaseUrl(store.get('baseUrl'))}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    requestId: error.requestId || null
  }
}

function supportsNativeImageEdits(model: string): boolean {
  return /(^|[-_.])(gpt-image|dall-e)/i.test(model)
}

function shouldTryAlternateProtocol(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false
  return [400, 404, 405, 415, 422].includes(error.status)
    || /parse.*json|json body|multipart|content[- ]type|unsupported/i.test(error.message)
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

async function editWithImagesApi(request: EditRequest): Promise<EditResponse> {
  const { buffer, mime } = dataUrlToBuffer(request.imageDataUrl)
  const form = new FormData()
  form.append('image', new Blob([buffer], { type: mime }), request.fileName || 'image.png')
  form.append('prompt', request.prompt)
  form.append('model', request.model)
  if (request.size && request.size !== 'auto') form.append('size', request.size)
  form.append('response_format', 'b64_json')

  const response = await apiFetch('/v1/images/edits', { method: 'POST', body: form })
  const body = (await response.json()) as Record<string, unknown>
  const source = findImageSource(body)
  if (!source) throw new Error('图像编辑接口成功返回，但响应中没有可识别的图片')
  const item = Array.isArray(body.data) ? body.data[0] as Record<string, unknown> | undefined : undefined
  return {
    imageDataUrl: await imageSourceToDataUrl(source),
    revisedPrompt: typeof item?.revised_prompt === 'string' ? item.revised_prompt : undefined,
    protocol: 'images-edits'
  }
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

  ipcMain.handle('api:balance', async (): Promise<BalanceInfo> => {
    try {
      const response = await apiFetch('/api/usage/token')
      const body = (await response.json()) as Record<string, unknown>
      const data = (body.data || body) as Record<string, unknown>
      const total = Number(data.total_granted ?? data.total_available ?? data.quota ?? NaN)
      const used = Number(data.total_used ?? data.used ?? NaN)
      if (Number.isFinite(total)) return { available: true, amount: total, used: Number.isFinite(used) ? used : undefined, unit: 'quota' }
    } catch (error) {
      writeLog('warn', 'api.balance.unavailable', errorMessage(error), errorDetails(error))
      // Not every New API deployment exposes token-level balance lookup.
    }
    return { available: false, message: '余额需登录控制台查看' }
  })

  ipcMain.handle('api:edit-image', async (_event, request: EditRequest): Promise<EditResponse> => {
    const attempts = supportsNativeImageEdits(request.model)
      ? [editWithImagesApi, editWithChatApi]
      : [editWithChatApi, editWithImagesApi]
    const protocolNames = supportsNativeImageEdits(request.model)
      ? ['images-edits', 'chat-completions']
      : ['chat-completions', 'images-edits']

    writeLog('info', 'image.edit.started', '开始 AI 图片编辑', {
      model: request.model,
      fileName: request.fileName,
      size: request.size || 'auto',
      promptLength: request.prompt.length,
      preferredProtocol: protocolNames[0]
    })

    for (let index = 0; index < attempts.length; index += 1) {
      const protocol = protocolNames[index]
      try {
        const result = await attempts[index](request)
        writeLog('info', 'image.edit.completed', 'AI 图片编辑成功', { model: request.model, protocol })
        return result
      } catch (error) {
        const isLast = index === attempts.length - 1
        writeLog(isLast ? 'error' : 'warn', 'image.edit.attempt.failed', errorMessage(error), {
          model: request.model,
          protocol,
          ...errorDetails(error)
        })
        if (isLast || !shouldTryAlternateProtocol(error)) {
          const requestId = error instanceof ApiRequestError && error.requestId ? `（请求 ID：${error.requestId}）` : ''
          throw new Error(`${errorMessage(error)}${requestId}。详情已写入运行日志。`)
        }
        writeLog('info', 'image.edit.fallback', '请求格式不兼容，自动切换备用协议', {
          model: request.model,
          from: protocol,
          to: protocolNames[index + 1]
        })
      }
    }
    throw new Error('AI 图片编辑失败。详情已写入运行日志。')
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
