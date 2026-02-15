import { useState } from 'react'
import Sidebar from './Sidebar'
import NavigationRail from './NavigationRail'
import MusicPlayer from './MusicPlayer'
import NewsPage from './NewsPage'
import GamePage from './GamePage'
import Settings from './Settings'

interface ChatSession {
  id: string
  name: string
  created_at: string
  last_message_at: string
  message_count: number
}

interface DashboardLayoutProps {
  children: React.ReactNode
  sessions: ChatSession[]
  activeSessionId: string | null
  autoSelectId: string | null
  onSelectSession: (sessionId: string) => void
  onNewChat: () => void
  onDeleteSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, newName: string) => void
  themeMode: 'light' | 'dark'
  setThemeMode: (mode: 'light' | 'dark') => void
  themeConfig: {
    mode: 'light' | 'dark'
    ema_rgb: [number, number, number]
    accent_rgb: [number, number, number]
    panel_rgb: [number, number, number]
    panel_alpha: number
  }
  setThemeConfig: (cfg: {
    mode: 'light' | 'dark'
    ema_rgb: [number, number, number]
    accent_rgb: [number, number, number]
    panel_rgb: [number, number, number]
    panel_alpha: number
  }) => void
  fontConfig: {
    family: string
    size_scale: number
    weight: number
  }
  setFontConfig: (cfg: {
    family: string
    size_scale: number
    weight: number
  }) => void
}

export default function DashboardLayout({
  children,
  sessions,
  activeSessionId,
  autoSelectId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onRenameSession,
  themeMode,
  setThemeMode,
  themeConfig,
  setThemeConfig,
  fontConfig,
  setFontConfig,
}: DashboardLayoutProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'music' | 'news' | 'settings' | 'game'>('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem('ema_sidebar_collapsed') === 'true'
  )

  const handleTabChange = (tab: 'chat' | 'news' | 'music' | 'settings' | 'acacia' | 'game') => {
    if (tab === 'acacia') {
      window.open('https://acacia-create.com/', '_blank', 'noopener,noreferrer')
    } else {
      setActiveTab(tab)
    }
  }

  const handleToggleSidebar = () => {
    const newState = !sidebarCollapsed
    setSidebarCollapsed(newState)
    localStorage.setItem('ema_sidebar_collapsed', newState.toString())
  }

  return (
    <div className="flex h-screen p-4 gap-4">
      <NavigationRail activeTab={activeTab} onTabChange={handleTabChange} />

      <div className={`contents ${activeTab === 'chat' ? '' : 'hidden'}`}>
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          autoSelectId={autoSelectId}
          onSelectSession={onSelectSession}
          onNewChat={onNewChat}
          onDeleteSession={onDeleteSession}
          onRenameSession={onRenameSession}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
        />
        <main className="flex-1 h-full min-w-0">
          {children}
        </main>
      </div>

      {activeTab === 'news' && (
        <div className="flex-1 h-full min-w-0"><NewsPage /></div>
      )}
      {activeTab === 'music' && (
        <div className="flex-1 h-full min-w-0"><MusicPlayer viewMode="full" /></div>
      )}
      {activeTab === 'game' && (
        <div className="flex-1 h-full min-w-0"><GamePage /></div>
      )}
      {activeTab === 'settings' && (
        <div className="flex-1 h-full min-w-0">
          <Settings
            themeMode={themeMode}
            setThemeMode={setThemeMode}
            themeConfig={themeConfig}
            setThemeConfig={setThemeConfig}
            fontConfig={fontConfig}
            setFontConfig={setFontConfig}
          />
        </div>
      )}
    </div>
  )
}
