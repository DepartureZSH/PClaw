import Store from 'electron-store'
import type { LogEntry, LogLevel } from '../shared/types'

type LogStore = { entries: LogEntry[] }

const MAX_LOG_ENTRIES = 300
const logStore = new Store<LogStore>({
  name: 'logs',
  defaults: { entries: [] }
})

function sanitizeText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据已隐藏]')
    .slice(0, 1200)
}

function sanitizeDetails(details?: Record<string, unknown>): LogEntry['details'] {
  if (!details) return undefined
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (/key|authorization|imageData|prompt/i.test(key)) return [key, '[已隐藏]']
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return [key, value]
      return [key, sanitizeText(String(value))]
    })
  )
}

export function writeLog(
  level: LogLevel,
  event: string,
  message: string,
  details?: Record<string, unknown>
): LogEntry {
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    event,
    message: sanitizeText(message),
    details: sanitizeDetails(details)
  }
  const entries = logStore.get('entries', [])
  logStore.set('entries', [entry, ...entries].slice(0, MAX_LOG_ENTRIES))
  return entry
}

export function listLogs(): LogEntry[] {
  return logStore.get('entries', [])
}

export function clearLogs(): void {
  logStore.set('entries', [])
}

export function formatLogs(entries = listLogs()): string {
  if (!entries.length) return 'PClaw 暂无运行日志。\n'
  return entries.map((entry) => {
    const details = entry.details ? `\n  ${JSON.stringify(entry.details)}` : ''
    return `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.event}\n  ${entry.message}${details}`
  }).join('\n\n') + '\n'
}
