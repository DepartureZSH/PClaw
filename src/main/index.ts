import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { join, extname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import Store from 'electron-store'
import type { ApiSettings, BalanceInfo, EditRequest, EditResponse, ModelInfo } from '../shared/types'

type SettingsStore = {
  baseUrl: string
  encryptedApiKey?: string
}

const store = new Store<SettingsStore>({
  name: 'settings',
  defaults: { baseUrl: 'https://chatbot.cn.unreachablecity.club' }
})

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
  const response = await fetch(`${normalizeBaseUrl(store.get('baseUrl'))}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...init.headers
    }
  })
  if (!response.ok) {
    const body = await response.text()
    let message = `请求失败 (${response.status})`
    try {
      const parsed = JSON.parse(body)
      message = parsed.error?.message || parsed.message || message
    } catch {
      if (body.trim()) message = body.slice(0, 300)
    }
    throw new Error(message)
  }
  return response
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('图片数据格式无效')
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings())
  ipcMain.handle('settings:save', (_event, value: { baseUrl: string; apiKey?: string }) => {
    store.set('baseUrl', normalizeBaseUrl(value.baseUrl))
    if (value.apiKey?.trim()) saveApiKey(value.apiKey)
    return settings()
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
    const response = await apiFetch('/v1/models')
    const body = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> }
    return (body.data || []).map((item) => ({ id: item.id, ownedBy: item.owned_by }))
  })

  ipcMain.handle('api:balance', async (): Promise<BalanceInfo> => {
    try {
      const response = await apiFetch('/api/usage/token')
      const body = (await response.json()) as Record<string, unknown>
      const data = (body.data || body) as Record<string, unknown>
      const total = Number(data.total_granted ?? data.total_available ?? data.quota ?? NaN)
      const used = Number(data.total_used ?? data.used ?? NaN)
      if (Number.isFinite(total)) return { available: true, amount: total, used: Number.isFinite(used) ? used : undefined, unit: 'quota' }
    } catch {
      // Not every New API deployment exposes token-level balance lookup.
    }
    return { available: false, message: '余额需登录控制台查看' }
  })

  ipcMain.handle('api:edit-image', async (_event, request: EditRequest): Promise<EditResponse> => {
    const { buffer, mime } = dataUrlToBuffer(request.imageDataUrl)
    const form = new FormData()
    form.append('image', new Blob([buffer], { type: mime }), request.fileName || 'image.png')
    form.append('prompt', request.prompt)
    form.append('model', request.model)
    if (request.size && request.size !== 'auto') form.append('size', request.size)
    form.append('response_format', 'b64_json')

    const response = await apiFetch('/v1/images/edits', { method: 'POST', body: form })
    const body = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
    }
    const item = body.data?.[0]
    if (!item) throw new Error('模型没有返回图片')
    if (item.b64_json) return { imageDataUrl: `data:image/png;base64,${item.b64_json}`, revisedPrompt: item.revised_prompt }
    if (item.url) {
      const imageResponse = await fetch(item.url)
      if (!imageResponse.ok) throw new Error('无法下载模型返回的图片')
      const contentType = imageResponse.headers.get('content-type') || 'image/png'
      const resultBuffer = Buffer.from(await imageResponse.arrayBuffer())
      return { imageDataUrl: `data:${contentType};base64,${resultBuffer.toString('base64')}`, revisedPrompt: item.revised_prompt }
    }
    throw new Error('模型返回的图片格式不受支持')
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

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
