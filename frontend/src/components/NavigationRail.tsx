import { MessageSquareText, Newspaper, Music2, Puzzle, Settings } from 'lucide-react'

interface NavigationRailProps {
  activeTab: 'chat' | 'news' | 'music' | 'settings' | 'game' | 'acacia'
  onTabChange: (tab: 'chat' | 'news' | 'music' | 'settings' | 'acacia' | 'game') => void
}

export default function NavigationRail({ activeTab, onTabChange }: NavigationRailProps) {
  const navItems = [
    { id: 'chat', label: '聊天', icon: MessageSquareText },
    { id: 'news', label: '魔裁资讯', icon: Newspaper },
    { id: 'music', label: '音乐播放', icon: Music2 },
    { id: 'game', label: '拼图游戏', icon: Puzzle },
    { id: 'acacia', label: 'Acacia 官方网站', icon: null },
    { id: 'settings', label: '设置', icon: Settings },
  ] as const

  return (
    <div className="w-16 h-full glass-panel rounded-2xl flex flex-col items-center py-5 gap-4 shrink-0 relative z-[80]">
      <div className="w-10 h-10 rounded-full overflow-hidden border border-pink-300/70 shadow-sm">
        <img src="/ema.png" alt="ema" className="w-full h-full object-cover" />
      </div>

      <div className="flex-1 flex flex-col gap-3 w-full px-2">
        {navItems.map((item) => {
          const active = activeTab === item.id
          const isAcacia = item.id === 'acacia'
          return (
            <div key={item.id} className="relative group">
              <button
                onClick={() => onTabChange(item.id)}
                className={`w-full h-10 rounded-xl flex items-center justify-center transition-all ${
                  active
                    ? isAcacia
                      ? 'bg-black text-white shadow-md'
                      : 'bg-ema text-white shadow-md'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
                }`}
              >
                {isAcacia ? (
                  <span className="w-5 h-5 rounded-md bg-black text-white text-[11px] font-semibold flex items-center justify-center">A</span>
                ) : (
                  item.icon && <item.icon size={16} strokeWidth={1.6} />
                )}
              </button>

              <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2.5 py-1 rounded-lg bg-slate-900 text-white text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-[300]">
                {item.label}
              </div>
            </div>
          )
        })}
      </div>

      <div className="text-[10px] text-theme-muted">v0.2</div>
    </div>
  )
}
