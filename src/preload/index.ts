import { contextBridge, ipcRenderer } from 'electron'
import type { ApiSettings, EditRequest, EditResponse, LogEntry, ModelInfo, UsageInfo } from '../shared/types'

const desktopApi = {
  openImage: (): Promise<{ dataUrl: string; fileName: string } | null> => ipcRenderer.invoke('file:open-image'),
  saveImage: (dataUrl: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save-image', dataUrl, suggestedName),
  getSettings: (): Promise<ApiSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (baseUrl: string, apiKey?: string): Promise<ApiSettings> =>
    ipcRenderer.invoke('settings:save', { baseUrl, apiKey }),
  fetchModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke('api:models'),
  fetchUsage: (): Promise<UsageInfo> => ipcRenderer.invoke('api:usage'),
  editImage: (request: EditRequest): Promise<EditResponse> => ipcRenderer.invoke('api:edit-image', request),
  listLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:list'),
  clearLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:clear'),
  exportLogs: (): Promise<string | null> => ipcRenderer.invoke('logs:export'),
  platform: process.platform
}

contextBridge.exposeInMainWorld('pclaw', desktopApi)

window.addEventListener('error', (event) => {
  ipcRenderer.send('logs:renderer-error', { message: event.message, source: event.filename })
})

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason)
  ipcRenderer.send('logs:renderer-error', { message, source: 'unhandledrejection' })
})

export type DesktopApi = typeof desktopApi
