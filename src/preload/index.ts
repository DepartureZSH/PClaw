import { contextBridge, ipcRenderer } from 'electron'
import type { ApiSettings, BalanceInfo, EditRequest, EditResponse, ModelInfo } from '../shared/types'

const desktopApi = {
  openImage: (): Promise<{ dataUrl: string; fileName: string } | null> => ipcRenderer.invoke('file:open-image'),
  saveImage: (dataUrl: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save-image', dataUrl, suggestedName),
  getSettings: (): Promise<ApiSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (baseUrl: string, apiKey?: string): Promise<ApiSettings> =>
    ipcRenderer.invoke('settings:save', { baseUrl, apiKey }),
  fetchModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke('api:models'),
  fetchBalance: (): Promise<BalanceInfo> => ipcRenderer.invoke('api:balance'),
  editImage: (request: EditRequest): Promise<EditResponse> => ipcRenderer.invoke('api:edit-image', request),
  platform: process.platform
}

contextBridge.exposeInMainWorld('pclaw', desktopApi)

export type DesktopApi = typeof desktopApi
