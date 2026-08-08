import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Aperture,
  Check,
  ChevronDown,
  Crop,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  RefreshCw,
  Redo2,
  RotateCcw,
  RotateCw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  ScrollText,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  X
} from 'lucide-react'
import type { ApiSettings, BalanceInfo, LogEntry, ModelInfo } from '../../shared/types'

type Adjustments = {
  brightness: number
  contrast: number
  saturation: number
  rotation: number
  flipX: boolean
  flipY: boolean
}

type CropRect = { x: number; y: number; width: number; height: number }
type Tool = 'adjust' | 'crop' | 'transform'

const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  rotation: 0,
  flipX: false,
  flipY: false
}

const PRESETS = [
  { name: '商业精修', prompt: '保持主体身份和构图不变，进行高端商业摄影精修：自然肤质，干净光影，克制锐化，真实细节，移除画面瑕疵。' },
  { name: '智能去物', prompt: '移除画面中不需要的物体，并根据周围纹理、光照和透视自然补全背景，不改变其他内容。' },
  { name: '证件照优化', prompt: '保持人物五官与身份完全一致，整理发丝和衣物，修正白平衡，使用均匀自然的证件照光线与纯净背景。' },
  { name: '电商白底', prompt: '完整保留商品结构、材质和品牌细节，移除原背景，生成纯白背景与自然柔和的接触阴影。' },
  { name: '清晰修复', prompt: '修复低清晰度、压缩伪影和轻微模糊，恢复可信的纹理细节与边缘，不改变原有内容。' },
  { name: '风格迁移', prompt: '保留原图主体、姿态和构图，将画面转换为精致的编辑插画风格，色彩统一，细节丰富。' },
  { name: '海马体·天蓝', prompt: '生成一张浅天蓝色高清海马体精修最美证件照，影棚柔光均匀布光，面部过渡柔和，没有生硬黑影。' },
  { name: '海马体·白底', prompt: '自然精致微调，保留原生五官，肤质细腻，轻美颜，不失真，高清证件照，纯白色纯色背景，海马体精致证件照风格，年轻东亚人物，面部清晰自然，五官端正，表情温和，影棚柔光，均匀布光，细腻皮肤纹理，淡妆精致，无多余装饰，无AI畸形，无模糊，8K高清，RAW画质，细节饱满，正式得体，不修改面部表情和五官。' }
]

const FALLBACK_MODELS = ['gpt-image-1', 'gpt-image-1.5', 'gemini-2.5-flash-image', 'nano-banana-pro']

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取图片'))
    image.src = dataUrl
  })
}

async function bakeImage(dataUrl: string, adjustments: Adjustments, crop?: CropRect): Promise<string> {
  const image = await loadImage(dataUrl)
  const normalizedRotation = ((adjustments.rotation % 360) + 360) % 360
  const swapsSides = normalizedRotation === 90 || normalizedRotation === 270
  const rotatedWidth = swapsSides ? image.naturalHeight : image.naturalWidth
  const rotatedHeight = swapsSides ? image.naturalWidth : image.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = rotatedWidth
  canvas.height = rotatedHeight
  const context = canvas.getContext('2d')!
  context.filter = `brightness(${adjustments.brightness}%) contrast(${adjustments.contrast}%) saturate(${adjustments.saturation}%)`
  context.translate(rotatedWidth / 2, rotatedHeight / 2)
  context.rotate((adjustments.rotation * Math.PI) / 180)
  context.scale(adjustments.flipX ? -1 : 1, adjustments.flipY ? -1 : 1)
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)

  if (!crop) return canvas.toDataURL('image/png')
  const cropped = document.createElement('canvas')
  cropped.width = Math.max(1, Math.round(canvas.width * crop.width))
  cropped.height = Math.max(1, Math.round(canvas.height * crop.height))
  cropped.getContext('2d')!.drawImage(
    canvas,
    canvas.width * crop.x,
    canvas.height * crop.y,
    canvas.width * crop.width,
    canvas.height * crop.height,
    0,
    0,
    cropped.width,
    cropped.height
  )
  return cropped.toDataURL('image/png')
}

function formatQuota(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 500_000) return `$${(value / 500_000).toFixed(2)}`
  return Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function App() {
  const [original, setOriginal] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [fileName, setFileName] = useState('image.png')
  const [dimensions, setDimensions] = useState({ original: '—', result: '—' })
  const [tool, setTool] = useState<Tool>('adjust')
  const [adjustments, setAdjustments] = useState(DEFAULT_ADJUSTMENTS)
  const [history, setHistory] = useState<Adjustments[]>([])
  const [future, setFuture] = useState<Adjustments[]>([])
  const [crop, setCrop] = useState<CropRect>({ x: 0.12, y: 0.12, width: 0.76, height: 0.76 })
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState(FALLBACK_MODELS[0])
  const [prompt, setPrompt] = useState(PRESETS[0].prompt)
  const [selectedPreset, setSelectedPreset] = useState(PRESETS[0].name)
  const [size, setSize] = useState('auto')
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [apiSettings, setApiSettings] = useState<ApiSettings>({ baseUrl: 'https://chatbot.cn.unreachablecity.club', hasApiKey: false })
  const [apiKey, setApiKey] = useState('')
  const [balance, setBalance] = useState<BalanceInfo>({ available: false, message: '未连接' })
  const cropStageRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ startX: number; startY: number; startCrop: CropRect } | null>(null)

  const displaySource = result || original
  const cssTransform = `rotate(${adjustments.rotation}deg) scale(${adjustments.flipX ? -1 : 1}, ${adjustments.flipY ? -1 : 1})`
  const cssFilter = `brightness(${adjustments.brightness}%) contrast(${adjustments.contrast}%) saturate(${adjustments.saturation}%)`

  const loadConnection = useCallback(async () => {
    if (!window.pclaw) return
    const current = await window.pclaw.getSettings()
    setApiSettings(current)
    if (!current.hasApiKey) return
    const [modelResult, balanceResult] = await Promise.allSettled([
      window.pclaw.fetchModels(),
      window.pclaw.fetchBalance()
    ])
    if (modelResult.status === 'fulfilled') {
      const imageModels = modelResult.value.filter((item) => /image|banana|flux|dall|seedream|ideogram/i.test(item.id))
      const list = imageModels.length ? imageModels : modelResult.value
      setModels(list)
      if (list[0]) setModel(list[0].id)
    }
    if (balanceResult.status === 'fulfilled') setBalance(balanceResult.value)
  }, [])

  useEffect(() => {
    void loadConnection()
  }, [loadConnection])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const inspectDimensions = useCallback(async (dataUrl: string, target: 'original' | 'result') => {
    const image = await loadImage(dataUrl)
    setDimensions((current) => ({ ...current, [target]: `${image.naturalWidth} × ${image.naturalHeight}` }))
  }, [])

  const openImage = useCallback(async () => {
    const selected = await window.pclaw.openImage()
    if (!selected) return
    setOriginal(selected.dataUrl)
    setResult(null)
    setFileName(selected.fileName)
    setAdjustments(DEFAULT_ADJUSTMENTS)
    setHistory([])
    setFuture([])
    void inspectDimensions(selected.dataUrl, 'original')
    setDimensions((current) => ({ ...current, result: '—' }))
  }, [inspectDimensions])

  const changeAdjustment = (key: keyof Adjustments, value: number | boolean) => {
    setAdjustments((current) => {
      setHistory((items) => [...items.slice(-30), current])
      setFuture([])
      return { ...current, [key]: value }
    })
  }

  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    setFuture((items) => [adjustments, ...items])
    setAdjustments(previous)
    setHistory((items) => items.slice(0, -1))
  }

  const redo = () => {
    const next = future[0]
    if (!next) return
    setHistory((items) => [...items, adjustments])
    setAdjustments(next)
    setFuture((items) => items.slice(1))
  }

  const applyCrop = async () => {
    if (!displaySource) return
    const baked = await bakeImage(displaySource, adjustments, crop)
    if (result) setResult(baked)
    else setOriginal(baked)
    setAdjustments(DEFAULT_ADJUSTMENTS)
    setCrop({ x: 0.12, y: 0.12, width: 0.76, height: 0.76 })
    setTool('adjust')
    void inspectDimensions(baked, result ? 'result' : 'original')
    setNotice('裁剪已应用')
  }

  const saveImage = async () => {
    if (!displaySource) return
    const baked = await bakeImage(displaySource, adjustments)
    const path = await window.pclaw.saveImage(baked, `PClaw-${fileName}`)
    if (path) setNotice(`已保存到 ${path}`)
  }

  const generate = async () => {
    if (!original) return setNotice('请先导入一张原图')
    if (!prompt.trim()) return setNotice('请输入编辑提示词')
    if (!apiSettings.hasApiKey) {
      setSettingsOpen(true)
      return setNotice('请先配置 API Key')
    }
    setGenerating(true)
    try {
      const prepared = await bakeImage(original, adjustments)
      const response = await window.pclaw.editImage({ imageDataUrl: prepared, fileName, prompt: prompt.trim(), model, size })
      setResult(response.imageDataUrl)
      setAdjustments(DEFAULT_ADJUSTMENTS)
      await inspectDimensions(response.imageDataUrl, 'result')
      setNotice('AI 编辑完成')
      const freshBalance = await window.pclaw.fetchBalance()
      setBalance(freshBalance)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '生成失败，请检查配置')
    } finally {
      setGenerating(false)
    }
  }

  const saveConnection = async () => {
    try {
      const saved = await window.pclaw.saveSettings(apiSettings.baseUrl, apiKey || undefined)
      setApiSettings(saved)
      setApiKey('')
      setSettingsOpen(false)
      setNotice('连接设置已保存')
      await loadConnection()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '设置保存失败')
    }
  }

  const refreshLogs = useCallback(async () => {
    const entries = await window.pclaw.listLogs()
    setLogs(entries)
  }, [])

  const openLogs = async () => {
    if (!window.pclaw) {
      setLogs([])
      setLogsOpen(true)
      return
    }
    await refreshLogs()
    setLogsOpen(true)
  }

  const clearRunLogs = async () => {
    setLogs(await window.pclaw.clearLogs())
    setNotice('运行日志已清空')
  }

  const exportRunLogs = async () => {
    const path = await window.pclaw.exportLogs()
    if (path) {
      setNotice(`日志已导出到 ${path}`)
      await refreshLogs()
    }
  }

  const cropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = cropStageRef.current?.getBoundingClientRect()
    if (!rect) return
    dragging.current = {
      startX: (event.clientX - rect.left) / rect.width,
      startY: (event.clientY - rect.top) / rect.height,
      startCrop: crop
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const cropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !cropStageRef.current) return
    const rect = cropStageRef.current.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    const dx = x - dragging.current.startX
    const dy = y - dragging.current.startY
    setCrop({
      ...dragging.current.startCrop,
      x: Math.min(1 - dragging.current.startCrop.width, Math.max(0, dragging.current.startCrop.x + dx)),
      y: Math.min(1 - dragging.current.startCrop.height, Math.max(0, dragging.current.startCrop.y + dy))
    })
  }

  const resizeCrop = (dimension: 'width' | 'height', percentage: number) => {
    const nextSize = percentage / 100
    setCrop((current) => {
      const center = dimension === 'width' ? current.x + current.width / 2 : current.y + current.height / 2
      const next = { ...current, [dimension]: nextSize }
      if (dimension === 'width') next.x = Math.max(0, Math.min(1 - nextSize, center - nextSize / 2))
      else next.y = Math.max(0, Math.min(1 - nextSize, center - nextSize / 2))
      return next
    })
  }

  const modelOptions = useMemo(() => models.length ? models.map((item) => item.id) : FALLBACK_MODELS, [models])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Aperture size={19} strokeWidth={2.4} /></div>
          <div><strong>PClaw</strong><span>AI IMAGE STUDIO</span></div>
        </div>
        <div className="project-name">
          <span className="status-dot" />
          {original ? fileName : '未命名项目'}
          <ChevronDown size={14} />
        </div>
        <div className="top-actions">
          <button className="balance" onClick={() => setSettingsOpen(true)}>
            <span>可用余额</span>
            <strong>{balance.available ? formatQuota(balance.amount) : '—'}</strong>
          </button>
          <button className="icon-button" aria-label="运行日志" onClick={() => void openLogs()}><ScrollText size={18} /></button>
          <button className="icon-button" aria-label="连接设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
          <button className="export-button" disabled={!displaySource} onClick={saveImage}><Download size={16} /> 导出</button>
        </div>
      </header>

      <section className="studio-grid">
        <nav className="toolrail" aria-label="编辑工具">
          <button className={tool === 'adjust' ? 'active' : ''} onClick={() => setTool('adjust')}><SlidersHorizontal /><span>调节</span></button>
          <button className={tool === 'crop' ? 'active' : ''} onClick={() => setTool('crop')}><Crop /><span>裁剪</span></button>
          <button className={tool === 'transform' ? 'active' : ''} onClick={() => setTool('transform')}><Maximize2 /><span>变换</span></button>
          <div className="rail-spacer" />
          <button disabled={!history.length} onClick={undo}><Undo2 /><span>撤销</span></button>
          <button disabled={!future.length} onClick={redo}><Redo2 /><span>重做</span></button>
        </nav>

        <section className="workspace">
          <div className="workspace-toolbar">
            <div className="view-label"><span>双图对照</span><i>原图与结果独立缩放</i></div>
            <div className="zoom-control">画布适配 <span>100%</span></div>
          </div>

          {!original ? (
            <button className="empty-canvas" onClick={openImage}>
              <div className="empty-art">
                <div className="orb orb-one" />
                <div className="orb orb-two" />
                <div className="scanline" />
                <ImagePlus size={42} />
              </div>
              <strong>把第一张图片交给 PClaw</strong>
              <span>支持 PNG、JPG、JPEG 和 WebP</span>
              <em><Upload size={16} /> 选择本地图片</em>
            </button>
          ) : (
            <div className="comparison-stage">
              <figure className="image-pane original-pane">
                <figcaption><span>原图</span><small>{dimensions.original}</small></figcaption>
                <div className="checkerboard">
                  <img src={original} alt="原图" />
                </div>
              </figure>
              <figure className="image-pane result-pane">
                <figcaption>
                  <span>{result ? 'AI 结果' : '编辑预览'}</span>
                  <small>{result ? dimensions.result : dimensions.original}</small>
                </figcaption>
                <div className={`checkerboard result-canvas ${generating ? 'is-generating' : ''}`} ref={cropStageRef}>
                  <img src={displaySource || ''} alt="编辑结果" style={{ filter: cssFilter, transform: cssTransform }} />
                  {tool === 'crop' && !generating && (
                    <div className="crop-mask">
                      <div
                        className="crop-rect"
                        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
                        onPointerDown={cropPointerDown}
                        onPointerMove={cropPointerMove}
                        onPointerUp={() => { dragging.current = null }}
                      >
                        <i /><i /><i /><i />
                      </div>
                      <button className="apply-crop" onClick={applyCrop}><Check size={15} /> 应用裁剪</button>
                    </div>
                  )}
                  {generating && <div className="generating-overlay"><LoaderCircle /><strong>AI 正在重绘画面</strong><span>请保持 PClaw 开启</span></div>}
                </div>
              </figure>
            </div>
          )}

          {original && (
            <div className="quick-controls">
              {tool === 'adjust' && <>
                <RangeControl label="亮度" value={adjustments.brightness} min={50} max={150} onChange={(value) => changeAdjustment('brightness', value)} />
                <RangeControl label="对比度" value={adjustments.contrast} min={50} max={150} onChange={(value) => changeAdjustment('contrast', value)} />
                <RangeControl label="饱和度" value={adjustments.saturation} min={0} max={200} onChange={(value) => changeAdjustment('saturation', value)} />
              </>}
              {tool === 'transform' && <div className="transform-actions">
                <button onClick={() => changeAdjustment('rotation', adjustments.rotation - 90)}><RotateCcw />左转 90°</button>
                <button onClick={() => changeAdjustment('rotation', adjustments.rotation + 90)}><RotateCw />右转 90°</button>
                <button onClick={() => changeAdjustment('flipX', !adjustments.flipX)}><FlipHorizontal2 />水平翻转</button>
                <button onClick={() => changeAdjustment('flipY', !adjustments.flipY)}><FlipVertical2 />垂直翻转</button>
              </div>}
              {tool === 'crop' && <>
                <RangeControl label="裁剪宽" value={Math.round(crop.width * 100)} min={20} max={100} onChange={(value) => resizeCrop('width', value)} />
                <RangeControl label="裁剪高" value={Math.round(crop.height * 100)} min={20} max={100} onChange={(value) => resizeCrop('height', value)} />
                <div className="crop-hint">拖动裁剪框定位</div>
              </>}
            </div>
          )}
        </section>

        <aside className="ai-panel">
          <div className="panel-heading"><div><WandSparkles size={18} /><strong>AI 编辑</strong></div><span className={apiSettings.hasApiKey ? 'connected' : ''}>{apiSettings.hasApiKey ? '已连接' : '未连接'}</span></div>

          <label className="field-label" htmlFor="model">模型</label>
          <div className="select-wrap">
            <select id="model" value={model} onChange={(event) => setModel(event.target.value)}>
              {modelOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <ChevronDown size={15} />
          </div>

          <div className="preset-heading"><label className="field-label">提示词预设</label><span>{PRESETS.length} 个</span></div>
          <div className="preset-grid">
            {PRESETS.map((preset) => (
              <button key={preset.name} className={selectedPreset === preset.name ? 'active' : ''} onClick={() => { setSelectedPreset(preset.name); setPrompt(preset.prompt) }}>
                {preset.name}
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="prompt">编辑描述</label>
          <div className="prompt-wrap">
            <textarea id="prompt" value={prompt} maxLength={1000} onChange={(event) => { setPrompt(event.target.value); setSelectedPreset('') }} placeholder="描述希望 AI 如何修改图片…" />
            <span>{prompt.length} / 1000</span>
          </div>

          <div className="size-row">
            <label className="field-label" htmlFor="size">输出尺寸</label>
            <select id="size" value={size} onChange={(event) => setSize(event.target.value)}>
              <option value="auto">自动</option>
              <option value="1024x1024">1:1 · 1024²</option>
              <option value="1536x1024">3:2 · 横向</option>
              <option value="1024x1536">2:3 · 竖向</option>
            </select>
          </div>

          <div className="panel-spacer" />
          <div className="cost-note"><Sparkles size={14} /><span>实际费用由所选模型与 New API 分组倍率决定</span></div>
          <button className="generate-button" disabled={generating || !original} onClick={generate}>
            {generating ? <LoaderCircle className="spin" /> : <Sparkles />}
            {generating ? '正在生成…' : '开始 AI 编辑'}
          </button>
          <button className="replace-button" onClick={openImage}><Upload size={15} /> {original ? '更换原图' : '导入原图'}</button>
        </aside>
      </section>

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
          <form className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={(event) => { event.preventDefault(); void saveConnection() }}>
            <div className="modal-head"><div><span>CONNECTION</span><h2 id="settings-title">New API 设置</h2></div><button type="button" onClick={() => setSettingsOpen(false)}><X /></button></div>
            <p>密钥由 Electron 主进程通过系统安全存储加密，页面无法读取明文。</p>
            <label>API 地址<input value={apiSettings.baseUrl} onChange={(event) => setApiSettings((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
            <label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiSettings.hasApiKey ? '已保存；留空表示不修改' : 'sk-…'} /></label>
            <div className="connection-status"><span className={apiSettings.hasApiKey ? 'connected' : ''} />{apiSettings.hasApiKey ? '本机已保存密钥' : '尚未配置密钥'}</div>
            <div className="modal-actions"><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" type="submit">保存并连接</button></div>
          </form>
        </div>
      )}

      {logsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogsOpen(false) }}>
          <section className="logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-title">
            <div className="modal-head">
              <div><span>DIAGNOSTICS</span><h2 id="logs-title">运行日志</h2></div>
              <button type="button" onClick={() => setLogsOpen(false)}><X /></button>
            </div>
            <div className="logs-toolbar">
              <p>最近 {logs.length} 条，仅记录请求状态与错误上下文；API Key、提示词和图片内容会自动隐藏。</p>
              <div>
                <button onClick={() => void refreshLogs()}><RefreshCw size={14} />刷新</button>
                <button onClick={() => void exportRunLogs()}><Download size={14} />导出</button>
                <button className="danger" onClick={() => void clearRunLogs()}><Trash2 size={14} />清空</button>
              </div>
            </div>
            <div className="log-list">
              {logs.length === 0 ? <div className="empty-logs"><ScrollText /><strong>暂无运行日志</strong><span>模型请求与错误会显示在这里</span></div> : logs.map((entry) => (
                <article className={`log-entry ${entry.level}`} key={entry.id}>
                  <div className="log-meta"><span>{entry.level}</span><strong>{entry.event}</strong><time>{new Date(entry.timestamp).toLocaleString('zh-CN')}</time></div>
                  <p>{entry.message}</p>
                  {entry.details && <pre>{JSON.stringify(entry.details, null, 2)}</pre>}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {notice && <div className="toast"><Check size={16} />{notice}</div>}
    </main>
  )
}

function RangeControl({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label className="range-control"><span>{label}</span><input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /><output>{value}</output></label>
}

export default App
