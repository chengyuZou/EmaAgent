import { Plus, MessageCircle, Trash2, MoreHorizontal, Pencil, Columns2 } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

interface ChatSession {
  id: string
  name: string
  created_at: string
  last_message_at: string
  message_count: number
}

interface SidebarProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  autoSelectId: string | null          
  onSelectSession: (sessionId: string) => void
  onNewChat: () => void
  onDeleteSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, newName: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export default function Sidebar({
  sessions,
  activeSessionId,
  autoSelectId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onRenameSession,
  collapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; name: string } | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // 自动滚动到当前选中的 session
  const activeItemRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if ((activeSessionId || autoSelectId) && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [activeSessionId, autoSelectId])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // 日期格式：显示固定格式 2026.02.09
  const formatDate = (dateStr: string) => {
    if (!dateStr) return ''
    try {
      const normalized = dateStr.includes('T') && !dateStr.endsWith('Z') && !dateStr.includes('+')
        ? dateStr + 'Z'
        : dateStr
      const date = new Date(normalized)
      if (isNaN(date.getTime())) return ''

      // 其他日期格式：2026.02.09
      const y = date.getFullYear()
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      return `${y}.${m}.${d}`
    } catch {
      return ''
    }
  }

  const handleMenuClick = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setOpenMenuId(openMenuId === sessionId ? null : sessionId)
  }

  const handleRenameClick = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation()
    setOpenMenuId(null)
    setRenamingId(session.id)
    setRenameValue(session.name)
  }

  const submitRename = (sessionId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== sessions.find(s => s.id === sessionId)?.name) {
      onRenameSession(sessionId, trimmed)
    }
    setRenamingId(null)
    setRenameValue('')
  }

  const handleDeleteClick = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation()
    setOpenMenuId(null)
    setSessionToDelete({ id: session.id, name: session.name })
    setShowDeleteModal(true)
  }

  const confirmDelete = () => {
    if (sessionToDelete) {
      onDeleteSession(sessionToDelete.id)
      setShowDeleteModal(false)
      setSessionToDelete(null)
    }
  }

  return (
    <>
      <div className={`h-full glass-panel rounded-2xl flex flex-col transition-all duration-300 ${
        collapsed ? 'w-16 p-2' : 'w-72 p-4'
      }`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          {!collapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-2xl font-display font-bold bg-clip-text text-transparent bg-gradient-to-r from-ema to-accent truncate">
                EmaAgent
              </h1>
            </div>
          )}
          {onToggleCollapse && (
            <button onClick={onToggleCollapse} className="p-2 hover:bg-ema/10 rounded-lg transition-colors">
              <Columns2 size={17} strokeWidth={1.8} className={collapsed ? '' : 'text-ema'} />
            </button>
          )}
        </div>

        {/* New Chat Button */}
        <button
          onClick={onNewChat}
          className={`flex items-center gap-2 bg-ema hover:bg-ema-dark text-white rounded-xl transition-colors mb-4 ${
            collapsed ? 'p-3 justify-center' : 'px-4 py-3'
          }`}
        >
          <Plus size={20} />
          {!collapsed && <span>新对话</span>}
        </button>

        {/* Sessions List */}
        {!collapsed && (
          <div className="flex-1 overflow-y-auto space-y-1">
            {/* 新建对话时，如果 activeSessionId 为 null，顶部显示“新聊天”占位项 */}
            {activeSessionId === null && (
              <div className="flex items-center gap-3 p-3 rounded-xl bg-ema/20 border border-ema/30">
                <div className="w-2 h-2 rounded-full shrink-0 bg-ema" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate text-slate-700 dark:text-slate-200">新聊天</p>
                  <p className="text-xs text-theme-muted mt-0.5">发送消息开始对话</p>
                </div>
              </div>
            )}

            {sessions.length === 0 && activeSessionId !== null ? (
              <div className="text-center text-theme-muted py-8">
                <MessageCircle size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无对话</p>
              </div>
            ) : (
              sessions.map((session) => {
                const isActive = activeSessionId === session.id
                const isAutoSelect = autoSelectId === session.id

                return (
                  <div
                    key={session.id}
                    ref={isActive || isAutoSelect ? activeItemRef : null}
                    className={`group relative flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all duration-200 ${
                      isActive
                        ? 'bg-ema/20 border border-ema/30'
                        : isAutoSelect
                          // 自动选中动画：快速高亮，模拟点击感
                          ? 'bg-ema/30 border border-ema/50 scale-[0.98] shadow-inner'
                          : 'hover:bg-white/50'
                    }`}
                    onClick={() => {
                      if (renamingId !== session.id) onSelectSession(session.id)
                    }}
                  >
                    <div className={`w-2 h-2 rounded-full shrink-0 transition-all ${
                      isActive || isAutoSelect ? 'bg-ema scale-110' : 'bg-slate-300'
                    }`} />

                    <div className="flex-1 min-w-0">
                      {renamingId === session.id ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onBlur={() => submitRename(session.id)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') submitRename(session.id)
                            if (e.key === 'Escape') { setRenamingId(null); setRenameValue('') }
                          }}
                          onClick={e => e.stopPropagation()}
                          className="w-full text-sm font-medium bg-white dark:bg-slate-700 border border-ema/50 rounded-md px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-ema/40"
                        />
                      ) : (
                        <p className="text-sm font-medium truncate">{session.name}</p>
                      )}
                      {/* 时间：具体日期格式 + 消息条数 */}
                      <p className="text-xs text-theme-muted mt-0.5">
                        {formatDate(session.last_message_at)}
                        {session.message_count > 0 && (
                          <span className="ml-1.5 opacity-60">· {session.message_count} 条</span>
                        )}
                      </p>
                    </div>

                    {/* 三点菜单 */}
                    <div className="relative" ref={openMenuId === session.id ? menuRef : null}>
                      <button
                        onClick={(e) => handleMenuClick(session.id, e)}
                        className={`p-1.5 rounded-lg transition-all ${
                          openMenuId === session.id
                            ? 'opacity-100 bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200'
                            : 'opacity-0 group-hover:opacity-100 text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-slate-200'
                        }`}
                        title="更多操作"
                      >
                        <MoreHorizontal size={16} />
                      </button>

                      {openMenuId === session.id && (
                        <div
                          className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 z-50 overflow-hidden py-1"
                          onClick={e => e.stopPropagation()}
                        >
                          <button
                            onClick={(e) => handleRenameClick(session, e)}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                          >
                            <Pencil size={15} className="text-slate-500" />
                            重命名
                          </button>
                          <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                          <button
                            onClick={(e) => handleDeleteClick(session, e)}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          >
                            <Trash2 size={15} />
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[9999]">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl p-6 w-[420px] border border-slate-200 dark:border-slate-700">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2">删除对话</h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              确定要删除对话<span className="font-semibold text-slate-900 dark:text-white">"{sessionToDelete?.name}"</span> 吗？此操作无法撤销。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setShowDeleteModal(false); setSessionToDelete(null) }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

