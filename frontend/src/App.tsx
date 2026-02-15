import { useEffect, useRef, useState } from 'react'
import DashboardLayout from './components/DashboardLayout'
import ChatInterface from './components/ChatInterface'

interface ChatSession {
  id: string
  name: string
  created_at: string
  last_message_at: string
  message_count: number
}

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

function App() {
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('ema_theme') as 'light' | 'dark') || 'light',
  )
  const [themeConfig, setThemeConfig] = useState<UiThemeConfig>(() => {
    const raw = localStorage.getItem('ema_theme_config')
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {
        return {
          mode: 'light',
          ema_rgb: [139, 92, 246],
          accent_rgb: [59, 130, 246],
          panel_rgb: [255, 255, 255],
          panel_alpha: 0.6,
        }
      }
    }
    return {
      mode: 'light',
      ema_rgb: [139, 92, 246],
      accent_rgb: [59, 130, 246],
      panel_rgb: [255, 255, 255],
      panel_alpha: 0.6,
    }
  })
  const [fontConfig, setFontConfig] = useState<UiFontConfig>(() => {
    const raw = localStorage.getItem('ema_font_config')
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {
        return {
          family: "'Microsoft YaHei', 'PingFang SC', sans-serif",
          size_scale: 1,
          weight: 400,
        }
      }
    }
    return {
      family: "'Microsoft YaHei', 'PingFang SC', sans-serif",
      size_scale: 1,
      weight: 400,
    }
  })

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [autoSelectId] = useState<string | null>(null)
  const hasAutoSelected = useRef(false)
  const justCreatedRef = useRef(false)
  const [initialLoaded, setInitialLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.ui) return
        if (data.ui.theme) {
          const uiTheme = data.ui.theme as UiThemeConfig
          setThemeMode((uiTheme.mode as 'light' | 'dark') || 'light')
          setThemeConfig(uiTheme)
        }
        if (data.ui.font) {
          setFontConfig(data.ui.font as UiFontConfig)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    document.body.className = ''
    if (themeMode === 'dark') document.body.classList.add('theme-dark')

    const root = document.documentElement
    root.style.setProperty('--glass-opacity', themeConfig.panel_alpha.toString())
    root.style.setProperty('--color-ema', themeConfig.ema_rgb.join(' '))
    root.style.setProperty('--color-ema-dark', themeConfig.ema_rgb.map((v) => Math.max(0, Math.floor(v * 0.8))).join(' '))
    root.style.setProperty('--color-ema-light', themeConfig.ema_rgb.map((v) => Math.min(255, Math.floor(v * 1.2))).join(' '))
    root.style.setProperty('--color-accent', themeConfig.accent_rgb.join(' '))
    root.style.setProperty('--color-panel', themeConfig.panel_rgb.join(' '))
    root.style.setProperty('--font-family-custom', fontConfig.family)
    root.style.setProperty('--font-size-scale', String(fontConfig.size_scale))
    root.style.setProperty('--font-weight-custom', String(fontConfig.weight))

    localStorage.setItem('ema_theme', themeMode)
    localStorage.setItem('ema_theme_config', JSON.stringify({ ...themeConfig, mode: themeMode }))
    localStorage.setItem('ema_font_config', JSON.stringify(fontConfig))
  }, [themeMode, themeConfig, fontConfig])

  useEffect(() => {
    fetchSessions().then(() => setInitialLoaded(true))
    const interval = setInterval(fetchSessions, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem('ema_active_session', activeSessionId)
    }
  }, [activeSessionId])

  useEffect(() => {
    if (hasAutoSelected.current || sessions.length === 0 || !initialLoaded) return
    hasAutoSelected.current = true

    const savedId = localStorage.getItem('ema_active_session')
    const target = savedId ? (sessions.find((s) => s.id === savedId) ?? sessions[0]) : sessions[0]
    if (!target) return
    setActiveSessionId(target.id)
  }, [sessions, initialLoaded])

  const fetchSessions = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/sessions')
      const data = await res.json()

      const sessionList: ChatSession[] = data.sessions.map((s: any) => ({
        id: s.id,
        name: s.title || s.id,
        created_at: s.created_at,
        last_message_at: s.updated_at || s.last_message_at,
        message_count: s.message_count,
      }))

      setSessions(sessionList)
    } catch (e) {
      console.error('加载会话失败:', e)
    }
  }

  const handleNewChat = () => {
    setActiveSessionId(null)
    localStorage.removeItem('ema_active_session')
  }

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId)
  }

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await fetch(`http://localhost:8000/api/sessions/${sessionId}`, { method: 'DELETE' })
      if (activeSessionId === sessionId) {
        const rest = sessions.filter((s) => s.id !== sessionId)
        setActiveSessionId(rest.length > 0 ? rest[0].id : null)
      }
      await fetchSessions()
    } catch (e) {
      console.error('删除会话失败:', e)
    }
  }

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      const res = await fetch(`http://localhost:8000/api/sessions/${sessionId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName }),
      })
      if (res.ok) {
        const data = await res.json()
        if (activeSessionId === sessionId && data.new_id) {
          setActiveSessionId(data.new_id)
        }
        await fetchSessions()
      }
    } catch (e) {
      console.error('重命名会话失败:', e)
    }
  }

  const handleSessionCreated = async (sessionId: string) => {
    try {
      justCreatedRef.current = true
      await fetchSessions()
      setActiveSessionId(sessionId)
      setTimeout(() => {
        justCreatedRef.current = false
      }, 1000)
    } catch (e) {
      console.error('处理新会话失败:', e)
      justCreatedRef.current = false
    }
  }

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-slate-50 via-blue-50/50 to-cyan-50 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900">
      {initialLoaded ? (
        <DashboardLayout
          sessions={sessions}
          activeSessionId={activeSessionId}
          autoSelectId={autoSelectId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          themeConfig={themeConfig}
          setThemeConfig={setThemeConfig}
          fontConfig={fontConfig}
          setFontConfig={setFontConfig}
        >
          <ChatInterface
            activeSessionId={activeSessionId}
            onSessionCreated={handleSessionCreated}
            skipHistoryLoad={justCreatedRef}
          />
        </DashboardLayout>
      ) : (
        <div className="h-full w-full flex items-center justify-center">
          <div className="w-12 h-12 border-4 border-sky-200 border-t-sky-500 rounded-full animate-spin" />
        </div>
      )}

    </div>
  )
}

export default App
