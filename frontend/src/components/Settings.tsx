import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  KeyRound,
  Palette,
  RefreshCw,
  Save,
  Type,
  Upload,
} from 'lucide-react'

type TabId = 'api' | 'theme' | 'font' | 'paths'

interface UiThemeConfig {
  mode: 'light' | 'dark'
  ema_rgb: [number, number, number]
  accent_rgb: [number, number, number]
  panel_rgb: [number, number, number]
  panel_alpha: number
}

interface UiFontConfig {
  family: string
  size_scale: number
  weight: number
}

interface SettingsProps {
  themeMode: 'light' | 'dark'
  setThemeMode: (mode: 'light' | 'dark') => void
  themeConfig: UiThemeConfig
  setThemeConfig: (cfg: UiThemeConfig) => void
  fontConfig: UiFontConfig
  setFontConfig: (cfg: UiFontConfig) => void
}

interface ApiConfig {
  selected_model: string
  provider_keys: Record<string, string>
  embeddings_api_key: string
  embeddings_model: string
  embeddings_base_url: string
  tts: TtsConfig
  tts_api_key?: string
  tts_model?: string
  tts_voice?: string
}

interface TtsProviderConfig {
  api_key?: string
  api_key_env?: string
  base_url?: string
  model?: string
  voice?: string
  id?: string
  label?: string
  [key: string]: any
}

interface TtsConfig {
  provider: string
  providers: Record<string, TtsProviderConfig>
}

interface PathConfig {
  data_dir: string
  audio_dir: string
  log_dir: string
  music_dir: string
}

interface SystemStatus {
  backend: boolean
  websocket: boolean
  tts: boolean
  embeddings: boolean
  llm: boolean
}

interface ModelItem {
  id: string
  label: string
  enabled: boolean
}

const DEFAULT_TTS_CONFIG: TtsConfig = {
  provider: 'siliconflow',
  providers: {
    siliconflow: {
      label: '硅基流动 TTS',
      base_url: 'https://api.siliconflow.cn/v1',
      api_key: '',
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      voice: '',
    },
    vits_simple_api: {
      label: 'VITS Simple API',
      base_url: 'http://localhost:23456/voice/vits',
      api_key: 'NOT_REQUIRED',
      model: 'vits',
      id: '0',
    },
  },
}

const DEFAULT_API_CONFIG: ApiConfig = {
  selected_model: 'deepseek-chat',
  provider_keys: { deepseek: '', openai: '', qwen: '' },
  embeddings_api_key: '',
  embeddings_model: 'Pro/BAAI/bge-m3',
  embeddings_base_url: 'https://api.siliconflow.cn/v1',
  tts: DEFAULT_TTS_CONFIG,
}

const API_PORTAL_LINKS = [
  { label: 'DeepSeek API', url: 'https://platform.deepseek.com/api_keys' },
  { label: '阿里云百炼 API', url: 'https://bailian.console.aliyun.com/cn-beijing?tab=model&utm_content=se_1023046479#/api-key' },
  { label: 'OpenAI API', url: 'https://platform.openai.com/settings/organization/api-keys' },
  { label: '硅基流动 API', url: 'https://cloud.siliconflow.cn/me/account/ak' },
]

const DEFAULT_PATH_CONFIG: PathConfig = {
  data_dir: './data',
  audio_dir: './data/audio',
  log_dir: './logs',
  music_dir: './data/music',
}

function normalizeTtsConfig(input: any): TtsConfig {
  const providers: Record<string, TtsProviderConfig> = {
    ...DEFAULT_TTS_CONFIG.providers,
  }

  if (input && typeof input === 'object' && input.providers && typeof input.providers === 'object') {
    Object.entries(input.providers).forEach(([name, cfg]) => {
      if (cfg && typeof cfg === 'object') {
        providers[name] = {
          ...(providers[name] || {}),
          ...(cfg as TtsProviderConfig),
        }
      }
    })
  }

  let provider = DEFAULT_TTS_CONFIG.provider
  if (input && typeof input === 'object' && typeof input.provider === 'string' && input.provider.trim()) {
    provider = input.provider.trim()
  }

  if (!providers[provider]) {
    providers[provider] = {}
  }

  return { provider, providers }
}

export default function Settings({
  themeMode,
  setThemeMode,
  themeConfig,
  setThemeConfig,
  fontConfig,
  setFontConfig,
}: SettingsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('api')
  const [apiConfig, setApiConfig] = useState<ApiConfig>(DEFAULT_API_CONFIG)
  const [pathConfig, setPathConfig] = useState<PathConfig>(DEFAULT_PATH_CONFIG)
  const [status, setStatus] = useState<SystemStatus>({
    backend: false,
    websocket: false,
    tts: false,
    embeddings: false,
    llm: false,
  })
  const [models, setModels] = useState<ModelItem[]>([])
  const [showApiKey, setShowApiKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isSwitchingTts, setIsSwitchingTts] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({
    status: true,
    llm: true,
    ebd: true,
    tts: true,
    colors: true,
    preview: true,
    fontBasic: true,
    fontPreview: true,
    pData: true,
    pAudio: true,
    pLog: true,
    pMusic: true,
  })

  const themeImportRef = useRef<HTMLInputElement>(null)
  const fontImportRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchSettings()
    fetchTtsSettings()
    fetchModels()
    refreshStatus()
  }, [])

  const enabledModels = useMemo(
    () => models.filter((m) => m.enabled).map((m) => m.label).join(' / ') || '暂无',
    [models],
  )

  const ttsProviderNames = useMemo(
    () => Object.keys(apiConfig.tts?.providers || {}),
    [apiConfig.tts],
  )

  const currentTtsProvider = apiConfig.tts?.provider || 'siliconflow'
  const currentTtsProviderConfig = apiConfig.tts?.providers?.[currentTtsProvider] || {}

  const togglePanel = (id: string) => setOpenPanels((prev) => ({ ...prev, [id]: !prev[id] }))

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings')
      if (!response.ok) return
      const data = await response.json()
      if (data.api) {
        setApiConfig((prev) => ({
          ...prev,
          ...data.api,
          provider_keys: {
            ...prev.provider_keys,
            ...(data.api.provider_keys || {}),
          },
          tts: normalizeTtsConfig(data.api.tts ?? prev.tts),
        }))
      }
      if (data.paths) {
        setPathConfig(data.paths)
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error)
    }
  }

  const fetchTtsSettings = async () => {
    try {
      const response = await fetch('/api/settings/tts')
      if (!response.ok) return
      const data = await response.json()
      setApiConfig((prev) => ({
        ...prev,
        tts: normalizeTtsConfig(data),
      }))
    } catch (error) {
      console.error('Failed to fetch TTS settings:', error)
    }
  }

  const fetchModels = async () => {
    try {
      const response = await fetch('/api/settings/models')
      if (!response.ok) return
      const data = await response.json()
      setModels((data.models || []) as ModelItem[])
      if (data.selected_model) {
        setApiConfig((prev) => ({ ...prev, selected_model: data.selected_model }))
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
    }
  }

  const refreshStatus = async () => {
    try {
      const response = await fetch('/api/settings/status')
      if (!response.ok) return
      const data = await response.json()
      setStatus(data)
      return data as SystemStatus
    } catch {
      setStatus({ backend: false, websocket: false, tts: false, embeddings: false, llm: false })
      return { backend: false, websocket: false, tts: false, embeddings: false, llm: false } as SystemStatus
    }
  }

  const refreshStatusWithRetry = async (retry = 3, delayMs = 250) => {
    let last: SystemStatus | undefined
    for (let i = 0; i < retry; i++) {
      last = await refreshStatus()
      if (last?.backend) {
        return last
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return last
  }

  const handleSave = async () => {
    setIsSaving(true)
    setSaveSuccess(false)
    setSaveError('')
    try {
      const apiPayload: ApiConfig = {
        ...apiConfig,
        tts: normalizeTtsConfig(apiConfig.tts),
      }

      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api: apiPayload,
          paths: pathConfig,
          ui: {
            theme: { ...themeConfig, mode: themeMode },
            font: fontConfig,
          },
        }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || '保存失败')
      }
      await fetchSettings()
      await fetchTtsSettings()
      await fetchModels()
      await refreshStatusWithRetry()
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (error: any) {
      setSaveError(error?.message || '保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const updateProviderKey = (provider: string, value: string) => {
    setApiConfig((prev) => ({
      ...prev,
      provider_keys: {
        ...prev.provider_keys,
        [provider]: value,
      },
    }))
  }

  const setTtsProvider = (providerName: string) => {
    setApiConfig((prev) => {
      const nextProviders = { ...(prev.tts?.providers || {}) }
      if (!nextProviders[providerName]) {
        nextProviders[providerName] = {}
      }
      return {
        ...prev,
        tts: {
          provider: providerName,
          providers: nextProviders,
        },
      }
    })
  }

  const updateCurrentTtsProviderField = (field: string, value: string) => {
    setApiConfig((prev) => {
      const providerName = prev.tts?.provider || 'siliconflow'
      const nextProviders = { ...(prev.tts?.providers || {}) }
      nextProviders[providerName] = {
        ...(nextProviders[providerName] || {}),
        [field]: value,
      }
      return {
        ...prev,
        tts: {
          provider: providerName,
          providers: nextProviders,
        },
      }
    })
  }

  const handleSwitchTtsProvider = async () => {
    const provider = currentTtsProvider
    if (!provider) return
    setSaveError('')
    setIsSwitchingTts(true)
    try {
      const response = await fetch('/api/settings/tts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || 'TTS Provider 切换失败')
      }
      await fetchTtsSettings()
      await refreshStatusWithRetry()
    } catch (error: any) {
      setSaveError(error?.message || 'TTS Provider 切换失败')
    } finally {
      setIsSwitchingTts(false)
    }
  }

  const updateThemeRgb = (field: 'ema_rgb' | 'accent_rgb' | 'panel_rgb', index: number, value: number) => {
    const next = [...themeConfig[field]] as [number, number, number]
    next[index] = Math.max(0, Math.min(255, value))
    setThemeConfig({ ...themeConfig, [field]: next })
  }

  const exportJson = (filename: string, payload: object) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const importTheme = (file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result || '{}'))
        setThemeMode(d.mode === 'dark' ? 'dark' : 'light')
        setThemeConfig({
          mode: d.mode === 'dark' ? 'dark' : 'light',
          ema_rgb: normalizeRgb(d.ema_rgb, themeConfig.ema_rgb),
          accent_rgb: normalizeRgb(d.accent_rgb, themeConfig.accent_rgb),
          panel_rgb: normalizeRgb(d.panel_rgb, themeConfig.panel_rgb),
          panel_alpha: normalizeAlpha(d.panel_alpha, themeConfig.panel_alpha),
        })
      } catch {
        setSaveError('主题 JSON 无效')
      }
    }
    reader.readAsText(file)
  }

  const importFont = (file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result || '{}'))
        setFontConfig({
          family: String(d.family || fontConfig.family),
          size_scale: normalizeScale(d.size_scale, fontConfig.size_scale),
          weight: normalizeWeight(d.weight, fontConfig.weight),
        })
      } catch {
        setSaveError('字体 JSON 无效')
      }
    }
    reader.readAsText(file)
  }

  const changePath = async (key: keyof PathConfig, title: string) => {
    setSaveError('')
    try {
      const response = await fetch('/api/settings/pick-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initial_dir: pathConfig[key],
          title: `选择${title}`,
        }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || '目录选择失败')
      }
      const data = await response.json()
      const selected = String(data?.path || '').trim()
      if (selected) {
        setPathConfig((prev) => ({ ...prev, [key]: selected }))
      }
    } catch (error: any) {
      setSaveError(error?.message || '目录选择器打开失败')
    }
  }

  const tabs: { id: TabId; label: string; icon: any }[] = [
    { id: 'api', label: 'API配置', icon: KeyRound },
    { id: 'theme', label: '主题样式', icon: Palette },
    { id: 'font', label: '字体样式', icon: Type },
    { id: 'paths', label: '路径设置', icon: Folder },
  ]

  return (
    <div className="h-full min-h-0 flex flex-col glass-panel rounded-2xl border border-ema/20">
      <div className="px-6 py-4 border-b border-ema/15 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">设置</h2>
          <p className="text-xs text-theme-muted">导航栏保持可见，设置仅在内容区域打开</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`px-4 py-2 rounded-xl text-white flex items-center gap-2 ${
              saveSuccess ? 'bg-green-600' : 'bg-ema hover:bg-ema/90'
            } disabled:opacity-60`}
          >
            {saveSuccess ? <Check size={16} /> : isSaving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
            {saveSuccess ? '已保存' : isSaving ? '保存中' : '保存设置'}
          </button>
        </div>
      </div>

      <div className="px-6 pt-4 border-b border-ema/10">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-xl border text-sm flex items-center gap-2 ${
                activeTab === tab.id
                  ? 'bg-ema text-white border-ema'
                  : 'bg-white/70 dark:bg-slate-800/60 border-ema/20 hover:bg-white'
              }`}
            >
              <tab.icon size={15} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
        {saveError && <div className="text-sm text-red-500">{saveError}</div>}

        {activeTab === 'api' && (
          <>
            <CollapseCard
              title="状态检测"
              open={openPanels.status}
              onToggle={() => togglePanel('status')}
              subtitle={`当前模型: ${apiConfig.selected_model} | 可用模型: ${enabledModels}`}
            >
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <StatusTag label="后端" ok={status.backend} />
                <StatusTag label="WebSocket" ok={status.websocket} />
                <StatusTag label="LLM" ok={status.llm} />
                <StatusTag label="EBD" ok={status.embeddings} />
                <StatusTag label="TTS" ok={status.tts} />
              </div>
              <button onClick={refreshStatus} className="mt-3 px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center gap-2">
                <RefreshCw size={14} />
                刷新状态
              </button>
            </CollapseCard>

            <CollapseCard title="LLM Keys" open={openPanels.llm} onToggle={() => togglePanel('llm')}>
              <div className="mb-3">
                <button onClick={() => setShowApiKey((v) => !v)} className="px-3 py-1.5 rounded-lg border border-ema/20 text-sm">
                  {showApiKey ? '隐藏Key' : '显示Key'}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {['deepseek', 'qwen', 'openai'].map((provider) => (
                  <Field
                    key={provider}
                    label={provider.toUpperCase()}
                    type={showApiKey ? 'text' : 'password'}
                    value={apiConfig.provider_keys?.[provider] || ''}
                    onChange={(v) => updateProviderKey(provider, v)}
                    placeholder={`输入 ${provider} API Key`}
                  />
                ))}
              </div>
              <div className="mt-3">
                <div className="text-sm text-theme-muted mb-2">API 官网快捷入口</div>
                <div className="flex flex-wrap gap-2">
                  {API_PORTAL_LINKS.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
                      className="px-3 py-2 rounded-xl border border-ema/20 bg-white/70 dark:bg-slate-800/70 hover:bg-white dark:hover:bg-slate-800 text-sm"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </CollapseCard>

            <CollapseCard title="EBD Key 与模型" open={openPanels.ebd} onToggle={() => togglePanel('ebd')}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field
                  label="Embedding API Key"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiConfig.embeddings_api_key}
                  onChange={(v) => setApiConfig({ ...apiConfig, embeddings_api_key: v })}
                />
                <Field
                  label="Embedding Base URL"
                  value={apiConfig.embeddings_base_url}
                  onChange={(v) => setApiConfig({ ...apiConfig, embeddings_base_url: v })}
                />
                <Field
                  label="Embedding Model"
                  value={apiConfig.embeddings_model}
                  onChange={(v) => setApiConfig({ ...apiConfig, embeddings_model: v })}
                />
              </div>
            </CollapseCard>

            <CollapseCard title="TTS Provider 配置" open={openPanels.tts} onToggle={() => togglePanel('tts')}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-theme-muted">TTS Provider</label>
                  <select
                    value={currentTtsProvider}
                    onChange={(e) => setTtsProvider(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white/90 dark:bg-slate-800 border border-ema/20 focus:outline-none"
                  >
                    {ttsProviderNames.map((provider) => {
                      const cfg = apiConfig.tts.providers[provider] || {}
                      const label = cfg.label || provider
                      return (
                        <option key={provider} value={provider}>
                          {label}
                        </option>
                      )
                    })}
                  </select>
                </div>

                <div className="flex items-end">
                  <button
                    onClick={handleSwitchTtsProvider}
                    disabled={isSwitchingTts || !currentTtsProvider}
                    className="w-full px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {isSwitchingTts ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    立即切换 Provider
                  </button>
                </div>

                <Field
                  label="TTS API Key"
                  type={showApiKey ? 'text' : 'password'}
                  value={String(currentTtsProviderConfig.api_key || '')}
                  onChange={(v) => updateCurrentTtsProviderField('api_key', v)}
                />
                <Field
                  label="TTS Base URL"
                  value={String(currentTtsProviderConfig.base_url || '')}
                  onChange={(v) => updateCurrentTtsProviderField('base_url', v)}
                />
                <Field
                  label="TTS Model"
                  value={String(currentTtsProviderConfig.model || '')}
                  onChange={(v) => updateCurrentTtsProviderField('model', v)}
                />

                {currentTtsProvider === 'vits_simple_api' ? (
                  <Field
                    label="VITS Speaker ID"
                    value={String(currentTtsProviderConfig.id || '0')}
                    onChange={(v) => updateCurrentTtsProviderField('id', v)}
                  />
                ) : (
                  <Field
                    label="TTS Voice（可选）"
                    value={String(currentTtsProviderConfig.voice || '')}
                    onChange={(v) => updateCurrentTtsProviderField('voice', v)}
                  />
                )}
              </div>
            </CollapseCard>
          </>
        )}

        {activeTab === 'theme' && (
          <>
            <CollapseCard title="颜色设置" open={openPanels.colors} onToggle={() => togglePanel('colors')}>
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setThemeMode('light')}
                  className={`px-3 py-1.5 rounded-lg border ${themeMode === 'light' ? 'bg-ema text-white border-ema' : 'border-ema/20'}`}
                >
                  浅色
                </button>
                <button
                  onClick={() => setThemeMode('dark')}
                  className={`px-3 py-1.5 rounded-lg border ${themeMode === 'dark' ? 'bg-ema text-white border-ema' : 'border-ema/20'}`}
                >
                  深色
                </button>
              </div>
              <RgbEditor label="主题色" value={themeConfig.ema_rgb} onChange={(i, v) => updateThemeRgb('ema_rgb', i, v)} />
              <RgbEditor label="强调色" value={themeConfig.accent_rgb} onChange={(i, v) => updateThemeRgb('accent_rgb', i, v)} />
              <RgbEditor label="面板底色" value={themeConfig.panel_rgb} onChange={(i, v) => updateThemeRgb('panel_rgb', i, v)} />
              <div className="mt-3">
                <div className="text-sm mb-1">透明度: {Math.round(themeConfig.panel_alpha * 100)}%</div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(themeConfig.panel_alpha * 100)}
                  onChange={(e) => setThemeConfig({ ...themeConfig, panel_alpha: Number(e.target.value) / 100 })}
                  className="w-full accent-ema"
                />
              </div>
            </CollapseCard>

            <CollapseCard title="预览 / JSON" open={openPanels.preview} onToggle={() => togglePanel('preview')}>
              <div
                className="rounded-xl p-4 mb-3"
                style={{
                  background: `rgba(${themeConfig.panel_rgb.join(',')}, ${themeConfig.panel_alpha})`,
                  border: `1px solid rgba(${themeConfig.ema_rgb.join(',')}, 0.3)`,
                }}
              >
                <div className="h-8 rounded-lg mb-2" style={{ background: `rgb(${themeConfig.ema_rgb.join(',')})` }} />
                <div className="h-8 rounded-lg" style={{ background: `rgb(${themeConfig.accent_rgb.join(',')})` }} />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => exportJson('theme.json', { ...themeConfig, mode: themeMode })}
                  className="px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center gap-2"
                >
                  <Download size={14} />
                  导出主题
                </button>
                <button
                  onClick={() => themeImportRef.current?.click()}
                  className="px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center gap-2"
                >
                  <Upload size={14} />
                  导入主题
                </button>
                <input ref={themeImportRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => importTheme(e.target.files?.[0])} />
              </div>
            </CollapseCard>
          </>
        )}

        {activeTab === 'font' && (
          <>
            <CollapseCard title="字体参数" open={openPanels.fontBasic} onToggle={() => togglePanel('fontBasic')}>
              <Field label="字体族" value={fontConfig.family} onChange={(v) => setFontConfig({ ...fontConfig, family: v })} />
              <div className="mt-3">
                <div className="text-sm mb-1">字号缩放: {fontConfig.size_scale.toFixed(2)}x</div>
                <input
                  type="range"
                  min={70}
                  max={160}
                  value={Math.round(fontConfig.size_scale * 100)}
                  onChange={(e) => setFontConfig({ ...fontConfig, size_scale: Number(e.target.value) / 100 })}
                  className="w-full accent-ema"
                />
              </div>
              <div className="mt-3">
                <div className="text-sm mb-1">字重: {fontConfig.weight}</div>
                <input
                  type="range"
                  min={300}
                  max={800}
                  step={100}
                  value={fontConfig.weight}
                  onChange={(e) => setFontConfig({ ...fontConfig, weight: Number(e.target.value) })}
                  className="w-full accent-ema"
                />
              </div>
            </CollapseCard>

            <CollapseCard title="预览 / JSON" open={openPanels.fontPreview} onToggle={() => togglePanel('fontPreview')}>
              <div className="rounded-xl border border-ema/15 p-4 mb-3">
                <div style={{ fontFamily: fontConfig.family, fontWeight: fontConfig.weight, fontSize: `${fontConfig.size_scale}rem` }}>
                  EmaAgent 字体预览 / 魔裁字体预览
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => exportJson('font.json', fontConfig)}
                  className="px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center gap-2"
                >
                  <Download size={14} />
                  导出字体
                </button>
                <button
                  onClick={() => fontImportRef.current?.click()}
                  className="px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center gap-2"
                >
                  <Upload size={14} />
                  导入字体
                </button>
                <input ref={fontImportRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => importFont(e.target.files?.[0])} />
              </div>
            </CollapseCard>
          </>
        )}

        {activeTab === 'paths' && (
          <>
            <CollapseCard title="数据目录" open={openPanels.pData} onToggle={() => togglePanel('pData')}>
              <PathRow
                value={pathConfig.data_dir}
                onValueChange={(v) => setPathConfig((prev) => ({ ...prev, data_dir: v }))}
                onChange={() => changePath('data_dir', '数据目录')}
              />
            </CollapseCard>
            <CollapseCard title="音频目录" open={openPanels.pAudio} onToggle={() => togglePanel('pAudio')}>
              <PathRow
                value={pathConfig.audio_dir}
                onValueChange={(v) => setPathConfig((prev) => ({ ...prev, audio_dir: v }))}
                onChange={() => changePath('audio_dir', '音频目录')}
              />
            </CollapseCard>
            <CollapseCard title="日志目录" open={openPanels.pLog} onToggle={() => togglePanel('pLog')}>
              <PathRow
                value={pathConfig.log_dir}
                onValueChange={(v) => setPathConfig((prev) => ({ ...prev, log_dir: v }))}
                onChange={() => changePath('log_dir', '日志目录')}
              />
            </CollapseCard>
            <CollapseCard title="音乐目录" open={openPanels.pMusic} onToggle={() => togglePanel('pMusic')}>
              <PathRow
                value={pathConfig.music_dir}
                onValueChange={(v) => setPathConfig((prev) => ({ ...prev, music_dir: v }))}
                onChange={() => changePath('music_dir', '音乐目录')}
              />
            </CollapseCard>
          </>
        )}
      </div>
    </div>
  )
}

function CollapseCard({
  title,
  open,
  onToggle,
  subtitle,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  subtitle?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-ema/15 bg-white/70 dark:bg-slate-900/60">
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center justify-between text-left">
        <div>
          <div className="font-medium">{title}</div>
          {subtitle ? <div className="text-xs text-theme-muted mt-0.5">{subtitle}</div> : null}
        </div>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  )
}

function StatusTag({ label, ok }: { label: string; ok: boolean }) {
  return <div className={`px-3 py-2 rounded-lg text-sm ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{label}: {ok ? '正常' : '异常'}</div>
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-theme-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg bg-white/90 dark:bg-slate-800 border border-ema/20 focus:outline-none"
      />
    </div>
  )
}

function RgbEditor({
  label,
  value,
  onChange,
}: {
  label: string
  value: [number, number, number]
  onChange: (index: number, value: number) => void
}) {
  return (
    <div className="rounded-xl border border-ema/15 p-3 mb-3">
      <div className="text-sm mb-2">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        {(['R', 'G', 'B'] as const).map((ch, idx) => (
          <div key={ch}>
            <div className="text-xs text-theme-muted mb-1">{ch}: {value[idx]}</div>
            <input type="range" min={0} max={255} value={value[idx]} onChange={(e) => onChange(idx, Number(e.target.value))} className="w-full accent-ema" />
          </div>
        ))}
      </div>
    </div>
  )
}

function PathRow({
  value,
  onValueChange,
  onChange,
}: {
  value: string
  onValueChange: (v: string) => void
  onChange: () => void
}) {
  return (
    <div className="rounded-xl bg-slate-900 text-white px-4 py-3 flex items-center justify-between gap-3">
      <input
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="min-w-0 flex-1 px-3 py-2 rounded-lg bg-slate-800 text-blue-200 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-ema/40"
        placeholder="请输入路径"
      />
      <button onClick={onChange} className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 flex items-center gap-1.5 text-sm">
        <Folder size={14} />
        更改
      </button>
    </div>
  )
}

function normalizeRgb(input: any, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(input) || input.length !== 3) return fallback
  return [0, 1, 2].map((i) => {
    const num = Number(input[i])
    if (Number.isNaN(num)) return fallback[i]
    return Math.max(0, Math.min(255, Math.round(num)))
  }) as [number, number, number]
}

function normalizeAlpha(input: any, fallback: number): number {
  const num = Number(input)
  if (Number.isNaN(num)) return fallback
  return Math.max(0, Math.min(1, num))
}

function normalizeScale(input: any, fallback: number): number {
  const num = Number(input)
  if (Number.isNaN(num)) return fallback
  return Math.max(0.7, Math.min(1.6, num))
}

function normalizeWeight(input: any, fallback: number): number {
  const num = Number(input)
  if (Number.isNaN(num)) return fallback
  return Math.max(300, Math.min(800, Math.round(num / 100) * 100))
}

