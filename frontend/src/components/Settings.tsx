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
  Trash2,
  Type,
  Upload,
} from 'lucide-react'

type TabId = 'api' | 'mcp' | 'theme' | 'font' | 'paths'

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

interface McpRequiredKey {
  config_key: string
  env_name: string
  template: string
  value: string
}

interface McpServerMetadata {
  description: string
  tools: string[]
  required_keys: McpRequiredKey[]
}

interface McpSettingsData {
  mcp_servers: Record<string, Record<string, any>>
  metadata: Record<string, McpServerMetadata>
}

const DEFAULT_MCP_SETTINGS: McpSettingsData = {
  mcp_servers: {},
  metadata: {},
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
  { label: '阿里百炼 API', url: 'https://bailian.console.aliyun.com/cn-beijing?tab=model&utm_content=se_1023046479#/api-key' },
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
  const [mcpSettings, setMcpSettings] = useState<McpSettingsData>(DEFAULT_MCP_SETTINGS)
  const [expandedMcpServers, setExpandedMcpServers] = useState<Record<string, boolean>>({})
  // 按分区跟踪保存状态，避免“全局保存”耦合。
  const [savingSection, setSavingSection] = useState<TabId | null>(null)
  const [isSwitchingTts, setIsSwitchingTts] = useState(false)
  const [saveSuccessSection, setSaveSuccessSection] = useState<TabId | null>(null)
  const [saveError, setSaveError] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const [mcpPasteText, setMcpPasteText] = useState('')
  const [isImportingMcp, setIsImportingMcp] = useState(false)
  const [mcpKeyDrafts, setMcpKeyDrafts] = useState<Record<string, Record<string, string>>>({})
  const [pendingMcpServers, setPendingMcpServers] = useState<Record<string, boolean>>({})

  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({
    status: true,
    llm: true,
    ebd: true,
    tts: true,
    mcpImport: true,
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
    fetchMcpSettings()
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
  const mcpServerEntries = useMemo(
    () => Object.entries(mcpSettings.mcp_servers || {}),
    [mcpSettings.mcp_servers],
  )
  const maskSecret = () => '...'
  const formatSecret = (value: string) => (showApiKey ? value : maskSecret())

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

  const fetchMcpSettings = async () => {
    try {
      const response = await fetch('/api/settings/mcp')
      if (!response.ok) return
      const data = await response.json()
      const nextSettings: McpSettingsData = {
        mcp_servers: data?.mcp_servers && typeof data.mcp_servers === 'object' ? data.mcp_servers : {},
        metadata: data?.metadata && typeof data.metadata === 'object' ? data.metadata : {},
      }
      setMcpSettings(nextSettings)
      const nextExpanded: Record<string, boolean> = {}
      const nextDrafts: Record<string, Record<string, string>> = {}
      Object.keys(nextSettings.mcp_servers).forEach((name) => {
        nextExpanded[name] = false
        const requiredKeys = nextSettings.metadata?.[name]?.required_keys || []
        const keyMap: Record<string, string> = {}
        requiredKeys.forEach((item) => {
          const envName = String(item?.env_name || '').trim()
          if (!envName) return
          keyMap[envName] = String(item?.value || '')
        })
        nextDrafts[name] = keyMap
      })
      setExpandedMcpServers(nextExpanded)
      setMcpKeyDrafts(nextDrafts)
      setPendingMcpServers({})
    } catch (error) {
      console.error('Failed to fetch MCP settings:', error)
    }
  }

  const saveMcpSettings = async (nextSettings: McpSettingsData) => {
    const response = await fetch('/api/settings/mcp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcp_servers: nextSettings.mcp_servers,
      }),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err?.detail || 'MCP 配置保存失败')
    }
  }
  const handleImportMcpFromPaste = async () => {
    const raw = mcpPasteText.trim()
    if (!raw) {
      setSaveError('请先粘贴 MCP 配置 JSON')
      return
    }

    setSaveError('')
    setSaveSuccessSection(null)
    setIsImportingMcp(true)

    try {
      const response = await fetch('/api/settings/mcp/import-paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw_text: raw,
          overwrite_existing: true,
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || 'MCP 粘贴导入失败')
      }

      // 自动刷新 MCP 区块
      await fetchMcpSettings()
      setMcpPasteText('')
      markSectionSaved('mcp')
    } catch (error: any) {
      setSaveError(error?.message || 'MCP 粘贴导入失败')
    } finally {
      setIsImportingMcp(false)
    }
  }

  const toggleMcpServerExpanded = (serverName: string) => {
    setExpandedMcpServers((prev) => ({ ...prev, [serverName]: !prev[serverName] }))
  }

  const toggleMcpServerEnabled = async (serverName: string) => {
    const server = mcpSettings.mcp_servers[serverName] || {}
    const enabled = server.enabled !== false
    const nextSettings: McpSettingsData = {
      ...mcpSettings,
      mcp_servers: {
        ...mcpSettings.mcp_servers,
        [serverName]: {
          ...server,
          enabled: !enabled,
        },
      },
    }
    setMcpSettings(nextSettings)
    setSaveError('')
    setSaveSuccessSection(null)
    setPendingMcpServers((prev) => ({ ...prev, [serverName]: true }))
    try {
      await saveMcpSettings(nextSettings)
      await fetchMcpSettings()
      markSectionSaved('mcp')
    } catch (error: any) {
      setSaveError(error?.message || 'MCP 启用状态更新失败')
      await fetchMcpSettings()
    } finally {
      setPendingMcpServers((prev) => ({ ...prev, [serverName]: false }))
    }
  }

  const updateMcpServerKeyDraft = (serverName: string, envName: string, value: string) => {
    setMcpKeyDrafts((prev) => ({
      ...prev,
      [serverName]: {
        ...(prev[serverName] || {}),
        [envName]: value,
      },
    }))
  }

  const handleUpdateMcpServerKeys = async (serverName: string, requiredKeys: McpRequiredKey[]) => {
    const draftMap = mcpKeyDrafts[serverName] || {}
    const values: Record<string, string> = {}

    requiredKeys.forEach((item) => {
      const envName = String(item?.env_name || '').trim()
      if (!envName) return
      values[envName] = String(draftMap[envName] ?? item?.value ?? '')
    })

    if (Object.keys(values).length === 0) {
      setSaveError('当前 MCP 没有可更新的 Key')
      return
    }

    setSaveError('')
    setSaveSuccessSection(null)
    setPendingMcpServers((prev) => ({ ...prev, [serverName]: true }))
    try {
      const response = await fetch(`/api/settings/mcp/server/${encodeURIComponent(serverName)}/env`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || 'MCP Key 更新失败')
      }
      await fetchMcpSettings()
      markSectionSaved('mcp')
    } catch (error: any) {
      setSaveError(error?.message || 'MCP Key 更新失败')
    } finally {
      setPendingMcpServers((prev) => ({ ...prev, [serverName]: false }))
    }
  }

  const handleDeleteMcpServer = async (serverName: string) => {
    const shouldDelete = window.confirm(`确认删除 MCP 服务 "${serverName}" 吗？`)
    if (!shouldDelete) return

    setSaveError('')
    setSaveSuccessSection(null)
    setPendingMcpServers((prev) => ({ ...prev, [serverName]: true }))
    try {
      const response = await fetch(`/api/settings/mcp/server/${encodeURIComponent(serverName)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || '删除 MCP 服务失败')
      }
      await fetchMcpSettings()
      markSectionSaved('mcp')
    } catch (error: any) {
      setSaveError(error?.message || '删除 MCP 服务失败')
    } finally {
      setPendingMcpServers((prev) => ({ ...prev, [serverName]: false }))
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

  const markSectionSaved = (section: TabId) => {
    setSaveSuccessSection(section)
    setTimeout(() => {
      setSaveSuccessSection((current) => (current === section ? null : current))
    }, 2000)
  }

  const handleSaveApi = async () => {
    setSavingSection('api')
    setSaveError('')
    setSaveSuccessSection(null)
    try {
      // API 分区只提交 API 字段。
      const apiPayload: ApiConfig = {
        ...apiConfig,
        tts: normalizeTtsConfig(apiConfig.tts),
      }
      const response = await fetch('/api/settings/api', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiPayload),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || 'API 配置保存失败')
      }
      await fetchSettings()
      await fetchTtsSettings()
      await fetchModels()
      await refreshStatusWithRetry()
      markSectionSaved('api')
    } catch (error: any) {
      setSaveError(error?.message || 'API 配置保存失败')
    } finally {
      setSavingSection(null)
    }
  }
  const handleSaveTheme = async () => {
    setSavingSection('theme')
    setSaveError('')
    setSaveSuccessSection(null)
    try {
      const response = await fetch('/api/settings/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...themeConfig, mode: themeMode }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || '主题配置保存失败')
      }
      markSectionSaved('theme')
    } catch (error: any) {
      setSaveError(error?.message || '主题配置保存失败')
    } finally {
      setSavingSection(null)
    }
  }

  const handleSaveFont = async () => {
    setSavingSection('font')
    setSaveError('')
    setSaveSuccessSection(null)
    try {
      const response = await fetch('/api/settings/font', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fontConfig),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || '字体配置保存失败')
      }
      markSectionSaved('font')
    } catch (error: any) {
      setSaveError(error?.message || '字体配置保存失败')
    } finally {
      setSavingSection(null)
    }
  }

  const handleSavePaths = async () => {
    setSavingSection('paths')
    setSaveError('')
    setSaveSuccessSection(null)
    try {
      const response = await fetch('/api/settings/paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pathConfig),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.detail || '路径配置保存失败')
      }
      await fetchSettings()
      await refreshStatusWithRetry()
      markSectionSaved('paths')
    } catch (error: any) {
      setSaveError(error?.message || '路径配置保存失败')
    } finally {
      setSavingSection(null)
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
    { id: 'api', label: 'API 配置', icon: KeyRound },
    { id: 'mcp', label: 'MCP 工具', icon: KeyRound },
    { id: 'theme', label: '主题样式', icon: Palette },
    { id: 'font', label: '字体样式', icon: Type },
    { id: 'paths', label: '路径设置', icon: Folder },
  ]

  return (
    <div className="h-full min-h-0 flex flex-col glass-panel rounded-2xl border border-ema/20">
      <div className="px-6 py-4 border-b border-ema/15">
        <div>
          <h2 className="text-xl font-semibold">设置</h2>
          <p className="text-xs text-theme-muted">导航栏保持可见，设置仅在内容区域展开</p>
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
              title="Status"
              open={openPanels.status}
              onToggle={() => togglePanel('status')}
              subtitle={`Current model: ${apiConfig.selected_model} | Enabled models: ${enabledModels}`}
            >
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <StatusTag label="Backend" ok={status.backend} />
                <StatusTag label="WebSocket" ok={status.websocket} />
                <StatusTag label="LLM" ok={status.llm} />
                <StatusTag label="EBD" ok={status.embeddings} />
                <StatusTag label="TTS" ok={status.tts} />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowApiKey((prev) => !prev)}
                  className="px-3 py-2 rounded-lg border border-ema/20 text-sm bg-white/80 dark:bg-slate-900/70 hover:bg-white"
                >
                  {showApiKey ? 'Hide Key' : 'Show Key'}
                </button>
                <button onClick={refreshStatus} className="px-3 py-2 rounded-lg border border-ema/20 text-sm flex items-center gap-2">
                  <RefreshCw size={14} />
                  Refresh Status
                </button>
              </div>
            </CollapseCard>

            <CollapseCard title="LLM Keys" open={openPanels.llm} onToggle={() => togglePanel('llm')}>
              <div className="text-xs text-theme-muted mb-3">
                {showApiKey ? 'Keys are shown in plain text.' : 'Keys are hidden as ...'}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {['deepseek', 'qwen', 'openai'].map((provider) => (
                  <Field
                    key={provider}
                    label={provider.toUpperCase()}
                    type="text"
                    value={formatSecret(apiConfig.provider_keys?.[provider] || '')}
                    onChange={(v) => {
                      if (!showApiKey) return
                      updateProviderKey(provider, v)
                    }}
                    placeholder={`Input ${provider} API Key`}
                    disabled={!showApiKey}
                  />
                ))}
              </div>
              <div className="mt-3">
                <div className="text-sm text-theme-muted mb-2">API Portal Links</div>
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

            <CollapseCard title="EBD Key and Model" open={openPanels.ebd} onToggle={() => togglePanel('ebd')}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field
                  label="Embedding API Key"
                  type="text"
                  value={formatSecret(apiConfig.embeddings_api_key)}
                  onChange={(v) => {
                    if (!showApiKey) return
                    setApiConfig({ ...apiConfig, embeddings_api_key: v })
                  }}
                  disabled={!showApiKey}
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

            <CollapseCard title="TTS Provider Config" open={openPanels.tts} onToggle={() => togglePanel('tts')}>
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
                    Switch Provider Now
                  </button>
                </div>

                <Field
                  label="TTS API Key"
                  type="text"
                  value={formatSecret(String(currentTtsProviderConfig.api_key || ''))}
                  onChange={(v) => {
                    if (!showApiKey) return
                    updateCurrentTtsProviderField('api_key', v)
                  }}
                  disabled={!showApiKey}
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
                    label="TTS Voice (Optional)"
                    value={String(currentTtsProviderConfig.voice || '')}
                    onChange={(v) => updateCurrentTtsProviderField('voice', v)}
                  />
                )}
              </div>
            </CollapseCard>
            <SectionSaveBar
              label="Save API Settings"
              onClick={handleSaveApi}
              saving={savingSection === 'api'}
              saved={saveSuccessSection === 'api'}
              disabled={savingSection !== null}
            />
          </>
        )}

        {activeTab === 'mcp' && (
          <>
            <div className="space-y-3">
              <CollapseCard title="Add MCP (Paste Import)" open={openPanels.mcpImport} onToggle={() => togglePanel('mcpImport')}>
                <div className="text-xs text-theme-muted mb-2">
                  Supports both {"{ \"mcpServers\": { ... } }"} and {"{ \"MiniMax\": { ... } }"}.
                </div>

                <textarea
                  value={mcpPasteText}
                  onChange={(e) => setMcpPasteText(e.target.value)}
                  placeholder={`Example:
                {
                  "mcpServers": {
                    "MiniMax": {
                      "command": "uvx",
                      "args": ["minimax-mcp"],
                      "env": {
                        "MINIMAX_API_KEY": "<insert-your-api-key-here>"
                      }
                    }
                  }
                }`}
                  className="w-full min-h-[180px] px-3 py-2 rounded-xl border border-ema/20 bg-white/85 dark:bg-slate-900/70 text-sm font-mono"
                />

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleImportMcpFromPaste}
                    disabled={isImportingMcp || savingSection !== null}
                    className="px-3 py-2 rounded-lg border border-emerald-500 text-sm bg-emerald-500 text-white disabled:opacity-60"
                  >
                    {isImportingMcp ? '导入中...' : '导入'}
                  </button>

                  <button
                    type="button"
                    onClick={() => setMcpPasteText('')}
                    disabled={isImportingMcp || savingSection !== null}
                    className="px-3 py-2 rounded-lg border border-ema/20 text-sm disabled:opacity-60"
                  >
                    清空
                  </button>
                </div>
              </CollapseCard>

              {mcpServerEntries.length === 0 ? (
                <div className="rounded-2xl border border-ema/15 bg-white/70 dark:bg-slate-900/60 px-4 py-6 text-sm text-theme-muted">
                  No MCP server configured. Check `config/mcp.json` or import from paste above.
                </div>
              ) : (
                mcpServerEntries.map(([serverName, serverCfg]) => {
                  const cfg = serverCfg || {}
                  const enabled = cfg.enabled !== false
                  const expanded = !!expandedMcpServers[serverName]
                  const pending = !!pendingMcpServers[serverName]
                  const metadata = mcpSettings.metadata?.[serverName]
                  const description = metadata?.description || cfg.description || ''
                  const tools = Array.isArray(metadata?.tools) ? metadata.tools : []
                  const requiredKeys = Array.isArray(metadata?.required_keys) ? metadata.required_keys : []
                  const command = String(cfg.command || '')
                  const args = Array.isArray(cfg.args) ? cfg.args : []

                  return (
                    <section
                      key={serverName}
                      className={`rounded-2xl border transition-colors ${
                        enabled
                          ? 'border-emerald-300/60 bg-emerald-50/50 dark:bg-emerald-950/20'
                          : 'border-rose-300/50 bg-rose-50/50 dark:bg-rose-950/20'
                      }`}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleMcpServerExpanded(serverName)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleMcpServerExpanded(serverName)
                          }
                        }}
                        className="w-full px-4 py-4 flex items-center justify-between text-left gap-3"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold truncate">{serverName}</div>
                          <div className="text-xs text-theme-muted mt-1 truncate">
                            {command ? `${command} ${args.join(' ')}` : 'No command'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleUpdateMcpServerKeys(serverName, requiredKeys)
                            }}
                            disabled={pending || requiredKeys.length === 0}
                            className="min-w-[96px] px-3 py-1.5 rounded-2xl border text-sm font-medium border-blue-500 bg-blue-500 text-white disabled:opacity-60"
                          >
                            更新 Key
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void toggleMcpServerEnabled(serverName)
                            }}
                            disabled={pending}
                            className={`min-w-[96px] px-3 py-1.5 rounded-2xl border text-sm font-medium ${
                              enabled
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : 'border-slate-300 bg-white/80 text-slate-700 dark:bg-slate-900/80 dark:text-slate-200'
                            } disabled:opacity-60`}
                          >
                            {enabled ? '✅ 已启用' : '⬜ 已禁用'}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDeleteMcpServer(serverName)
                            }}
                            disabled={pending}
                            className="ml-1 w-9 h-9 inline-flex items-center justify-center rounded-xl border border-rose-400 bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-60"
                            title="删除 MCP 服务"
                            aria-label="删除 MCP 服务"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      {expanded ? (
                        <div className="px-4 pb-4 space-y-3">
                          <div>
                            <div className="text-xs uppercase tracking-wide text-theme-muted mb-1">Describe</div>
                            <div className="text-sm">{description || 'N/A'}</div>
                          </div>

                          <div>
                            <div className="text-xs uppercase tracking-wide text-theme-muted mb-1">Tools</div>
                            {tools.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {tools.map((tool) => (
                                  <span
                                    key={`${serverName}-${tool}`}
                                    className="px-2 py-1 rounded-lg text-xs border border-ema/20 bg-white/80 dark:bg-slate-900/70"
                                  >
                                    {tool}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-theme-muted">No tools found</div>
                            )}
                          </div>

                          <div>
                            <div className="text-xs uppercase tracking-wide text-theme-muted mb-1">Required Keys</div>
                            {requiredKeys.length > 0 ? (
                              <div className="space-y-2">
                                {requiredKeys.map((keyItem) => {
                                  const envName = String(keyItem.env_name || '').trim()
                                  if (!envName) return null
                                  const displayValue = String(mcpKeyDrafts?.[serverName]?.[envName] ?? keyItem.value ?? '')
                                  return (
                                    <div
                                      key={`${serverName}-${keyItem.config_key}-${envName}`}
                                      className="rounded-xl border border-ema/15 bg-white/80 dark:bg-slate-900/70 px-3 py-2"
                                    >
                                      <div className="text-xs text-theme-muted mb-1">
                                        {keyItem.config_key} {'->'} {envName}
                                      </div>
                                      {/* Edit MCP key and click update button to persist */}
                                      <input
                                        type="text"
                                        value={displayValue}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => updateMcpServerKeyDraft(serverName, envName, e.target.value)}
                                        disabled={pending}
                                        className="w-full font-mono text-sm px-2 py-1 rounded-lg border border-ema/20 bg-white dark:bg-slate-900"
                                      />
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="text-sm text-theme-muted">No extra keys required</div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </section>
                  )
                })
              )}
            </div>
          </>
        )}

        {activeTab === 'theme' && (
          <>
            <CollapseCard title="色彩设置" open={openPanels.colors} onToggle={() => togglePanel('colors')}>
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
            <SectionSaveBar
              label="保存主题配置"
              onClick={handleSaveTheme}
              saving={savingSection === 'theme'}
              saved={saveSuccessSection === 'theme'}
              disabled={savingSection !== null}
            />
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
                  EmaAgent 字体预览 / 示例文字预览
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
            <SectionSaveBar
              label="保存字体配置"
              onClick={handleSaveFont}
              saving={savingSection === 'font'}
              saved={saveSuccessSection === 'font'}
              disabled={savingSection !== null}
            />
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
            <SectionSaveBar
              label="保存路径配置"
              onClick={handleSavePaths}
              saving={savingSection === 'paths'}
              saved={saveSuccessSection === 'paths'}
              disabled={savingSection !== null}
            />
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
  disabled = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-theme-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 rounded-lg bg-white/90 dark:bg-slate-800 border border-ema/20 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
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

function SectionSaveBar({
  label,
  onClick,
  saving,
  saved,
  disabled,
}: {
  label: string
  onClick: () => void
  saving: boolean
  saved: boolean
  disabled: boolean
}) {
  return (
    <div className="pt-1 flex justify-end">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`px-4 py-2 rounded-xl text-white flex items-center gap-2 ${
          saved ? 'bg-green-600' : 'bg-ema hover:bg-ema/90'
        } disabled:opacity-60`}
      >
        {saved ? <Check size={16} /> : saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
        {saved ? '已保存' : saving ? '保存中' : label}
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


