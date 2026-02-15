import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Play, Pause, SkipBack, SkipForward, Volume2, Search,
  Upload, RefreshCw, Star, MoreHorizontal, Download,
  Pencil, X, ChevronRight, Music, Repeat, Repeat1,
  Shuffle, ListOrdered, CheckSquare, Square, Loader2, Trash2,
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════ //
//  Types
// ═══════════════════════════════════════════════════════════════════ //

interface Track {
  id: string
  title: string
  artist: string
  url: string
  duration: number
  play_count: number
  last_played: string | null
  is_favorited: boolean
  cover_art: string | null
}

type PlayMode = 'sequential' | 'loop-list' | 'loop-single' | 'shuffle'

interface MusicPlayerProps {
  viewMode: 'mini' | 'full'
}

// ═══════════════════════════════════════════════════════════════════ //
//  Module-level audio singleton — survives React unmount (Feature 7)
// ═══════════════════════════════════════════════════════════════════ //

interface GlobalAudioState {
  trackId: string | null
  trackUrl: string | null
  isPlaying: boolean
  volume: number
  playMode: PlayMode
}

let _gAudio: HTMLAudioElement | null = null
const _gState: GlobalAudioState = {
  trackId:  null,
  trackUrl: null,
  isPlaying: false,
  volume: 80,
  playMode: 'loop-list',
}

function getAudio(): HTMLAudioElement {
  if (typeof window !== 'undefined' && !_gAudio) {
    _gAudio = new Audio()
    _gAudio.volume = _gState.volume / 100
  }
  return _gAudio!
}

// ═══════════════════════════════════════════════════════════════════ //
//  Helpers
// ═══════════════════════════════════════════════════════════════════ //

const formatTime = (s: number): string => {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

const formatRelativeTime = (iso: string | null): string => {
  if (!iso) return '未播放'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  if (h < 24) return `${h}小时前`
  return `${d}天前`
}

// Feature 5: keyword search — split by spaces, all keywords must match (AND)
const matchesKeywords = (track: Track, query: string): boolean => {
  if (!query.trim()) return true
  const keywords = query.trim().toLowerCase().split(/\s+/)
  const haystack = `${track.title} ${track.artist}`.toLowerCase()
  return keywords.every(kw => haystack.includes(kw))
}

// Highlight matched keywords inline
const Highlighted = ({ text, query }: { text: string; query: string }) => {
  if (!query.trim()) return <>{text}</>
  const keywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(regex)
  return (
    <>
      {parts.map((p, i) =>
        keywords.some(k => k === p.toLowerCase())
          ? <mark key={i} className="bg-amber-200/70 text-inherit rounded-sm px-0.5">{p}</mark>
          : <span key={i}>{p}</span>
      )}
    </>
  )
}

const CONVERT_FORMATS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac']

// Feature 4: play mode cycle metadata
const PLAY_MODE_META: Record<PlayMode, { icon: React.ReactNode; label: string }> = {
  sequential:    { icon: <ListOrdered size={16} />, label: '顺序播放' },
  'loop-list':   { icon: <Repeat size={16} />,      label: '列表循环' },
  'loop-single': { icon: <Repeat1 size={16} />,     label: '单曲循环' },
  shuffle:       { icon: <Shuffle size={16} />,     label: '随机播放' },
}
const PLAY_MODE_ORDER: PlayMode[] = ['sequential', 'loop-list', 'loop-single', 'shuffle']

// ═══════════════════════════════════════════════════════════════════ //
//  Component
// ═══════════════════════════════════════════════════════════════════ //

export default function MusicPlayer({ viewMode }: MusicPlayerProps) {
  // ── core state ──
  const [tracks, setTracks]               = useState<Track[]>([])
  const [currentTrack, setCurrentTrack]   = useState<Track | null>(null)
  const [isPlaying, setIsPlaying]         = useState(false)
  const [volume, setVolume]               = useState(_gState.volume)
  const [currentTime, setCurrentTime]     = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [searchQuery, setSearchQuery]     = useState('')
  const [isLoading, setIsLoading]         = useState(false)
  const [playMode, setPlayMode]           = useState<PlayMode>(_gState.playMode)

  // ── context menu ──
  const [openMenuId, setOpenMenuId]             = useState<string | null>(null)
  const [menuPos, setMenuPos]                   = useState({ x: 0, y: 0 })
  const [showConvertPanel, setShowConvertPanel] = useState(false)

  // ── edit modal ──
  const [editingTrack, setEditingTrack]       = useState<Track | null>(null)
  const [editTitle, setEditTitle]             = useState('')
  const [editArtist, setEditArtist]           = useState('')
  const [editCoverPreview, setEditCoverPreview] = useState<string | null>(null)
  const [editCoverFile, setEditCoverFile]     = useState<File | null>(null)
  const [isSaving, setIsSaving]               = useState(false)

  // ── batch mode (Feature 6) ──
  const [batchMode, setBatchMode]           = useState(false)
  const [selectedIds, setSelectedIds]       = useState<Set<string>>(new Set())
  const [batchConverting, setBatchConverting] = useState(false)
  const [showBatchConvert, setShowBatchConvert] = useState(false)

  // ── refs ──
  const fileInputRef  = useRef<HTMLInputElement | null>(null)
  const batchFileRef  = useRef<HTMLInputElement | null>(null)
  const coverInputRef = useRef<HTMLInputElement | null>(null)
  const menuRef       = useRef<HTMLDivElement | null>(null)

  // Refs that avoid stale-closure bugs in audio event handlers
  const playModeRef  = useRef<PlayMode>(playMode)
  const tracksRef    = useRef<Track[]>(tracks)
  const filteredRef  = useRef<Track[]>([])

    // ✅ 新增：播放模式菜单状态
  const [showPlayModeMenu, setShowPlayModeMenu] = useState(false)
  const playModeButtonRef = useRef<HTMLButtonElement | null>(null)
  const playModeMenuRef = useRef<HTMLDivElement | null>(null)

  // Keep refs in sync
  useEffect(() => { playModeRef.current = playMode;  _gState.playMode = playMode }, [playMode])
  useEffect(() => { tracksRef.current   = tracks }, [tracks])

  // Derived filtered list (updated every render)
  const filteredTracks    = tracks.filter(t => matchesKeywords(t, searchQuery))
  filteredRef.current     = filteredTracks

  // ════════════════════════════════════════════════════════════════ //
  //  Lifecycle
  // ════════════════════════════════════════════════════════════════ //

  useEffect(() => {
    fetchPlaylist()
    const audio = getAudio()

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime)
      if (audio.duration && isFinite(audio.duration)) setAudioDuration(audio.duration)
    }
    const handleLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setAudioDuration(audio.duration)
        if (_gState.trackId) reportDuration(_gState.trackId, audio.duration)
      }
    }
    const handleEnded = () => handleTrackEnded()

    audio.addEventListener('timeupdate',      handleTimeUpdate)
    audio.addEventListener('loadedmetadata',  handleLoadedMetadata)
    audio.addEventListener('ended',           handleEnded)

    // Restore live state when component remounts (feature 7)
    setIsPlaying(!audio.paused)
    setVolume(_gState.volume)
    setPlayMode(_gState.playMode)
    if (audio.currentTime) setCurrentTime(audio.currentTime)
    if (audio.duration && isFinite(audio.duration)) setAudioDuration(audio.duration)

    return () => {
      // Do NOT pause — audio keeps playing across page changes
      audio.removeEventListener('timeupdate',     handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('ended',          handleEnded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restore currentTrack object after tracks load (feature 7)
  useEffect(() => {
    if (tracks.length > 0 && _gState.trackId && !currentTrack) {
      const saved = tracks.find(t => t.id === _gState.trackId)
      if (saved) setCurrentTrack(saved)
    }
  }, [tracks, currentTrack])

  // Volume sync
  useEffect(() => {
    const audio = getAudio()
    audio.volume = volume / 100
    _gState.volume = volume
  }, [volume])

  // Close context menu on outside click
  useEffect(() => {
    if (!openMenuId) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuId])

  // ════════════════════════════════════════════════════════════════ //
  //  Feature 4: Play mode logic
  // ════════════════════════════════════════════════════════════════ //

  const handleTrackEnded = useCallback(() => {
    const mode   = playModeRef.current
    const pool   = filteredRef.current.length > 0 ? filteredRef.current : tracksRef.current
    const curId  = _gState.trackId

    if (mode === 'loop-single') {
      const audio = getAudio()
      audio.currentTime = 0
      audio.play()
      if (curId) recordPlay(curId)
      return
    }
    if (mode === 'shuffle') {
      _playTrack(pool[Math.floor(Math.random() * pool.length)])
      return
    }
    const curIdx = pool.findIndex(t => t.id === curId)
    const next   = curIdx + 1
    if (next >= pool.length) {
      if (mode === 'loop-list') _playTrack(pool[0])
      // sequential: stop naturally
      return
    }
    _playTrack(pool[next])
  }, [])

  // Central play function (works via singleton audio element)
  const _playTrack = (track: Track) => {
    const audio = getAudio()
    audio.src = track.url
    audio.play()
    setCurrentTrack(track)
    setIsPlaying(true)
    setCurrentTime(0)
    _gState.trackId  = track.id
    _gState.trackUrl = track.url
    _gState.isPlaying = true
    recordPlay(track.id)  // ✅ 每次播放都记录
  }

  const playTrack = (track: Track) => _playTrack(track)

  const togglePlay = () => {
    const audio = getAudio()
    if (!_gState.trackId) return
    if (isPlaying) { audio.pause(); _gState.isPlaying = false }
    else           { audio.play();  _gState.isPlaying = true  }
    setIsPlaying(!isPlaying)
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value)
    getAudio().currentTime = t
    setCurrentTime(t)
  }

  const playNext = () => {
    const pool = filteredRef.current.length > 0 ? filteredRef.current : tracksRef.current
    if (!pool.length) return
    if (playModeRef.current === 'shuffle') { _playTrack(pool[Math.floor(Math.random() * pool.length)]); return }
    const idx = pool.findIndex(t => t.id === _gState.trackId)
    _playTrack(pool[(idx + 1) % pool.length])
  }

  const playPrev = () => {
    const pool = filteredRef.current.length > 0 ? filteredRef.current : tracksRef.current
    if (!pool.length) return
    if (playModeRef.current === 'shuffle') { _playTrack(pool[Math.floor(Math.random() * pool.length)]); return }
    const idx = pool.findIndex(t => t.id === _gState.trackId)
    _playTrack(pool[(idx - 1 + pool.length) % pool.length])
  }

  const setPlayModeDirectly = (mode: PlayMode) => {
    setPlayMode(mode)
    _gState.playMode = mode
    setShowPlayModeMenu(false)
  }

  // ✅ 新增：关闭播放模式菜单的点击外部监听
  useEffect(() => {
    if (!showPlayModeMenu) return
    const handleClick = (e: MouseEvent) => {
      if (
        playModeMenuRef.current &&
        !playModeMenuRef.current.contains(e.target as Node) &&
        playModeButtonRef.current &&
        !playModeButtonRef.current.contains(e.target as Node)
      ) {
        setShowPlayModeMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showPlayModeMenu])

  // ════════════════════════════════════════════════════════════════ //
  //  API helpers
  // ════════════════════════════════════════════════════════════════ //

  const fetchPlaylist = async () => {
    try {
      const res  = await fetch('/api/music/playlist')
      const data = await res.json()
      const incoming: Track[] = data.tracks || []
      setTracks(incoming)
      // Keep currentTrack fresh (e.g. after toggling favorite)
      if (_gState.trackId) {
        const fresh = incoming.find(t => t.id === _gState.trackId)
        if (fresh) setCurrentTrack(fresh)
      }
    } catch (err) { console.error('Failed to fetch playlist:', err) }
  }

  const recordPlay = async (trackId: string) => {
    try {
      const res = await fetch(`/api/music/${trackId}/play`, { method: 'POST' })
      if (res.ok) {
        const d = await res.json()
        setTracks(prev => prev.map(t =>
          t.id === trackId ? { ...t, play_count: d.play_count, last_played: d.last_played } : t
        ))
        setCurrentTrack(prev =>
          prev?.id === trackId ? { ...prev, play_count: d.play_count, last_played: d.last_played } : prev
        )
      }
    } catch (err) { console.error('记录播放失败:', err) }
  }

  const reportDuration = async (trackId: string, dur: number) => {
    if (dur <= 0 || !isFinite(dur)) return
    try {
      await fetch(`/api/music/${trackId}/duration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: dur }),
      })
      setTracks(prev => prev.map(t => t.id === trackId ? { ...t, duration: dur } : t))
    } catch {}
  }

  // Bug fix 2: 收藏后立即重新拉取列表（不依赖乐观更新）
  const handleToggleFavorite = async (track: Track, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      const res = await fetch(`/api/music/${track.id}/favorite`, { method: 'POST' })
      if (res.ok) {
        // 收藏成功后立即重新获取完整列表（包含正确排序）
        await fetchPlaylist()
      }
    } catch (err) {
      console.error('收藏失败:', err)
    }
  }

  // Bug fix 2: 刷新按钮应完整重新加载
  const handleRefresh = async () => {
    setIsLoading(true)
    try { 
      await fetchPlaylist() 
    } catch (err) {
      console.error('刷新失败:', err)
    } finally { 
      setIsLoading(false) 
    }
  }

  const stopAndClearPlayer = () => {
    const audio = getAudio()
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    setIsPlaying(false)
    setCurrentTime(0)
    setAudioDuration(0)
    setCurrentTrack(null)
    _gState.trackId = null
    _gState.trackUrl = null
    _gState.isPlaying = false
  }

  const removeTracksFromState = (ids: string[]) => {
    if (!ids.length) return
    const deleted = new Set(ids)
    if (_gState.trackId && deleted.has(_gState.trackId)) {
      stopAndClearPlayer()
    }
    setTracks(prev => prev.filter(t => !deleted.has(t.id)))
    setSelectedIds(prev => {
      const next = new Set(prev)
      ids.forEach(id => next.delete(id))
      return next
    })
  }

  const handleSaveEdit = async () => {
    if (!editingTrack) return
    setIsSaving(true)
    try {
      let updated: Partial<Track> = {}
      const r = await fetch(`/api/music/${editingTrack.id}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle, artist: editArtist }),
      })
      if (r.ok) { const d = await r.json(); updated = d.track }
      const updatedTrackId = typeof updated.id === 'string' ? updated.id : editingTrack.id
      if (editCoverFile) {
        const fd = new FormData(); fd.append('file', editCoverFile)
        const cr = await fetch(`/api/music/${updatedTrackId}/cover`, { method: 'POST', body: fd })
        if (cr.ok) { const cd = await cr.json(); updated.cover_art = cd.cover_art }
      }
      if (Object.keys(updated).length) {
        setTracks(prev => prev.map(t => t.id === editingTrack.id ? { ...t, ...updated } : t))
        setCurrentTrack(prev => prev?.id === editingTrack.id ? { ...prev, ...updated } as Track : prev)
        if (_gState.trackId === editingTrack.id && typeof updated.id === 'string') {
          _gState.trackId = updated.id
        }
        if (_gState.trackId === (typeof updated.id === 'string' ? updated.id : editingTrack.id) && typeof updated.url === 'string') {
          _gState.trackUrl = updated.url
        }
      }
    } finally { setIsSaving(false); setEditingTrack(null) }
  }

  const handleConvert = async (track: Track, format: string) => {
    closeMenu()
    try {
      const res = await fetch(`/api/music/${track.id}/convert?target_format=${format}`)
      if (!res.ok) { alert('转换失败，请确认服务器已安装 ffmpeg'); return }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `${track.title}.${format}`; a.click()
      URL.revokeObjectURL(url)
    } catch { alert('转换失败') }
  }

  const handleDownload = (track: Track) => {
    closeMenu()
    const a = document.createElement('a')
    a.href = track.url; a.download = track.url.split('/').pop() || track.title
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setIsLoading(true)
    try {
      for (const file of files) {
        const fd = new FormData(); fd.append('file', file)
        const res = await fetch('/api/music/upload', { method: 'POST', body: fd })
        if (res.ok) {
          const data = await res.json()
          const track = data.track
          // Bug fix 5: 如果后端未能获取时长，前端主动获取并上报
          if (track && (!track.duration || track.duration === 0)) {
            const tempAudio = document.createElement('audio')
            tempAudio.src = track.url
            tempAudio.addEventListener('loadedmetadata', () => {
              if (tempAudio.duration && isFinite(tempAudio.duration)) {
                reportDuration(track.id, tempAudio.duration)
              }
              tempAudio.remove()
            })
            tempAudio.addEventListener('error', () => tempAudio.remove())
            tempAudio.load()
          }
        }
      }
      await fetchPlaylist()
    } finally { setIsLoading(false); e.target.value = '' }
  }

  // ════════════════════════════════════════════════════════════════ //
  //  Feature 6: Batch operations
  // ════════════════════════════════════════════════════════════════ //

  const toggleBatchMode = () => {
    setBatchMode(v => !v)
    setSelectedIds(new Set())
    setShowBatchConvert(false)
  }

  const toggleSelectAll = () => {
    setSelectedIds(
      selectedIds.size === filteredTracks.length
        ? new Set()
        : new Set(filteredTracks.map(t => t.id))
    )
  }

  const batchDownload = async () => {
    const sel = tracks.filter(t => selectedIds.has(t.id))
    for (let i = 0; i < sel.length; i++) {
      await new Promise(r => setTimeout(r, i * 350))
      const a = document.createElement('a')
      a.href = sel[i].url; a.download = sel[i].url.split('/').pop() || sel[i].title
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    }
  }

  const batchFavorite = async (favor: boolean) => {
    const targets = tracks.filter(t => selectedIds.has(t.id) && t.is_favorited !== favor)
    for (const t of targets) await fetch(`/api/music/${t.id}/favorite`, { method: 'POST' })
    await fetchPlaylist()
  }

  const batchDelete = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`确定要删除 ${selectedIds.size} 首歌曲吗？`)) return
    const ids = Array.from(selectedIds)
    try {
      const res = await fetch('/api/music/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_ids: ids }),
      })
      if (!res.ok) {
        alert('批量删除失败，请检查后端服务')
        return
      }
      const data = await res.json()
      const removed = Array.isArray(data.removed) ? data.removed : []
      removeTracksFromState(removed)
      if (removed.length !== ids.length) {
        await fetchPlaylist()
      }
    } catch (err) {
      console.error('批量删除失败:', err)
      alert('批量删除失败，请检查后端服务')
    }
  }

  const handleDeleteTrack = async (track: Track) => {
    closeMenu()
    if (!confirm(`确定删除《${track.title}》吗？此操作会删除磁盘文件。`)) return
    try {
      const res = await fetch(`/api/music/${track.id}`, { method: 'DELETE' })
      if (!res.ok) {
        alert('删除失败')
        return
      }
      removeTracksFromState([track.id])
    } catch (err) {
      console.error('删除失败:', err)
      alert('删除失败，请检查后端服务')
    }
  }

  const batchConvertAll = async (format: string) => {
    setBatchConverting(true); setShowBatchConvert(false)
    const sel = tracks.filter(t => selectedIds.has(t.id))
    for (const track of sel) {
      try {
        const res = await fetch(`/api/music/${track.id}/convert?target_format=${format}`)
        if (res.ok) {
          const blob = await res.blob()
          const url  = URL.createObjectURL(blob)
          const a    = document.createElement('a')
          a.href = url; a.download = `${track.title}.${format}`; a.click()
          URL.revokeObjectURL(url)
        }
        await new Promise(r => setTimeout(r, 300))
      } catch {}
    }
    setBatchConverting(false)
  }

  // ── Context menu helpers ──
  const openMenu = (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    let x = rect.right - 188
    let y = rect.bottom + 6
    if (y + 200 > window.innerHeight) y = rect.top - 200 - 6
    if (x < 8) x = 8
    setMenuPos({ x, y }); setOpenMenuId(trackId); setShowConvertPanel(false)
  }
  const closeMenu = () => { setOpenMenuId(null); setShowConvertPanel(false) }

  const openEditModal = (track: Track) => {
    closeMenu()
    setEditingTrack(track); setEditTitle(track.title); setEditArtist(track.artist)
    setEditCoverPreview(track.cover_art); setEditCoverFile(null)
  }

  const handleCoverFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    setEditCoverFile(file)
    const r = new FileReader()
    r.onload = ev => setEditCoverPreview(ev.target?.result as string)
    r.readAsDataURL(file)
  }

  // ════════════════════════════════════════════════════════════════ //
  //  Guard
  // ════════════════════════════════════════════════════════════════ //

  if (viewMode === 'mini') return null

  const menuTrack  = openMenuId ? tracks.find(t => t.id === openMenuId) : null
  const allSelected = filteredTracks.length > 0 && selectedIds.size === filteredTracks.length

  // ════════════════════════════════════════════════════════════════ //
  //  Render
  // ════════════════════════════════════════════════════════════════ //

  return (
    <div className="h-full glass-panel rounded-2xl flex flex-col p-6">
      {/* ── Hidden inputs ── */}
      <input ref={fileInputRef}  type="file" accept=".mp3,.wav,.flac,.ogg,.m4a,.aac" className="hidden" onChange={handleUpload} />
      <input ref={batchFileRef}  type="file" accept=".mp3,.wav,.flac,.ogg,.m4a,.aac" multiple className="hidden" onChange={handleUpload} />
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={handleCoverFileChange} />

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <h2 className="text-2xl font-bold flex items-center gap-2">🎵 Music Station</h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={toggleBatchMode}
            className={`px-3 py-2 rounded-xl border text-sm flex items-center gap-1.5 transition-colors ${
              batchMode ? 'border-ema bg-ema/10 text-ema font-medium' : 'border-ema/20 hover:bg-ema/10'
            }`}>
            <CheckSquare size={14} /> 批量
          </button>
          <button onClick={handleRefresh} disabled={isLoading}
            className="px-3 py-2 rounded-xl border border-ema/20 hover:bg-ema/10 transition-colors flex items-center gap-1.5 text-sm disabled:opacity-50">
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> 刷新
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={isLoading}
            className="px-3 py-2 rounded-xl border border-ema/20 hover:bg-ema/10 transition-colors flex items-center gap-1.5 text-sm disabled:opacity-50">
            <Upload size={14} /> 上传
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-6 min-h-0">

        {/* ══════════════════════════════════════════ */}
        {/* Left: Player                              */}
        {/* ══════════════════════════════════════════ */}
        <div className="w-72 flex-shrink-0 flex flex-col items-center">

          {/* Album Art */}
          <div className="w-56 h-56 bg-gradient-to-br from-ema/20 to-accent/20 rounded-full flex items-center justify-center mb-5 shadow-lg overflow-hidden">
            {currentTrack?.cover_art ? (
              <img src={currentTrack.cover_art} alt="cover"
                className={`w-full h-full object-cover rounded-full ${isPlaying ? 'animate-spin-slow' : ''}`} />
            ) : (
              <div className={`w-40 h-40 bg-gradient-to-br from-ema to-accent rounded-full flex items-center justify-center text-white text-5xl
                ${isPlaying ? 'animate-spin-slow' : ''}`}>
                🎵
              </div>
            )}
          </div>

          {/* Track title + artist */}
          <div className="text-center mb-1 w-full px-2">
            <h3 className="font-bold text-base truncate">{currentTrack?.title || '未选择歌曲'}</h3>
            <p className="text-sm text-theme-muted truncate">{currentTrack?.artist || '选择一首歌曲开始播放'}</p>
          </div>

          {/* Stats: plays · last played · duration */}
          {currentTrack && (
            <div className="flex items-center gap-2 text-xs text-theme-muted mb-4 flex-wrap justify-center">
              <span className="flex items-center gap-0.5"><Play size={10} />{currentTrack.play_count}次</span>
              <span>·</span>
              <span>🕐 {formatRelativeTime(currentTrack.last_played)}</span>
              <span>·</span>
              <span>⏱ {formatTime(currentTrack.duration || audioDuration)}</span>
            </div>
          )}

          {/* Progress bar */}
          <div className="w-full mb-3 px-1">
            <input type="range" min="0" max={audioDuration || 0} value={currentTime}
              onChange={handleSeek}
              className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-ema" />
            <div className="flex justify-between text-xs text-theme-muted mt-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(audioDuration)}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 mb-3">
            <button onClick={playPrev} className="p-2 hover:bg-ema/10 rounded-full transition-colors">
              <SkipBack size={22} />
            </button>
            <button onClick={togglePlay} disabled={!currentTrack}
              className="w-12 h-12 bg-ema hover:bg-ema-dark disabled:bg-gray-300 text-white rounded-full flex items-center justify-center transition-colors shadow-md">
              {isPlaying ? <Pause size={24} /> : <Play size={24} className="ml-0.5" />}
            </button>
            <button onClick={playNext} className="p-2 hover:bg-ema/10 rounded-full transition-colors">
              <SkipForward size={22} />
            </button>
          </div>

          {/* Feature 4: Play mode + Volume */}
          <div className="flex items-center w-full gap-2 relative">
            <button
              ref={playModeButtonRef}
              onClick={() => setShowPlayModeMenu(v => !v)}
              title={PLAY_MODE_META[playMode].label}
              className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-ema/20 hover:bg-ema/10 text-xs text-theme-muted transition-colors whitespace-nowrap">
              {PLAY_MODE_META[playMode].icon}
              <span className="hidden xl:inline">{PLAY_MODE_META[playMode].label}</span>
            </button>
            <Volume2 size={15} className="text-theme-muted flex-shrink-0" />
            <input type="range" min="0" max="100" value={volume}
              onChange={e => setVolume(parseInt(e.target.value))}
              className="flex-1 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-ema" />
          </div>
        </div>

        {/* ══════════════════════════════════════════ */}
        {/* Right: Playlist                           */}
        {/* ══════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Feature 5: Keyword search bar */}
          <div className="relative mb-3">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜索歌曲… 多个关键词用空格分隔"
              className="w-full pl-9 pr-8 py-2.5 bg-white/50 border border-ema/20 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ema/30" />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-muted hover:text-foreground transition-colors">
                <X size={13} />
              </button>
            )}
          </div>

          {/* List column header */}
          <div className="flex items-center justify-between mb-1.5 px-1">
            <div className="flex items-center gap-2">
              {batchMode && (
                <button onClick={toggleSelectAll}
                  className="flex items-center gap-1 text-xs text-theme-muted hover:text-foreground transition-colors">
                  {allSelected
                    ? <CheckSquare size={13} className="text-ema" />
                    : <Square size={13} />}
                  全选
                </button>
              )}
              <span className="text-sm text-theme-muted">
                播放列表 ({filteredTracks.length})
                {batchMode && selectedIds.size > 0 && <span className="ml-1 text-ema font-medium">· 已选 {selectedIds.size}</span>}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-theme-muted pr-8">
              <span className="w-8 text-right">播放</span>
              <span className="w-10 text-right">时长</span>
            </div>
          </div>

          {/* Track rows */}
          <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
            {filteredTracks.length === 0 ? (
              <div className="text-center py-12 text-theme-muted">
                <Music size={36} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">{searchQuery ? '无匹配结果' : '暂无歌曲'}</p>
                <p className="text-xs mt-1 opacity-70">
                  {searchQuery ? '试试别的关键词，或用空格拆分多词' : '上传音乐文件开始播放'}
                </p>
              </div>
            ) : (
              filteredTracks.map(track => {
                const isActive   = currentTrack?.id === track.id
                const isSelected = selectedIds.has(track.id)
                return (
                  <div key={track.id}
                    onClick={() => batchMode
                      ? setSelectedIds(prev => { const n = new Set(prev); n.has(track.id) ? n.delete(track.id) : n.add(track.id); return n })
                      : playTrack(track)
                    }
                    className={`flex items-center gap-1.5 px-2 py-2 rounded-xl cursor-pointer transition-all group
                      ${track.is_favorited
                        ? isActive  ? 'bg-amber-100/90 border border-amber-300/60'
                                    : 'bg-amber-50/70 border border-amber-200/40 hover:bg-amber-100/60'
                        : isActive  ? 'bg-ema/20 border border-ema/30'
                                    : 'hover:bg-white/60 border border-transparent'}
                      ${isSelected ? 'ring-2 ring-ema/40' : ''}`}
                  >
                    {/* Bug fix 1: "..." button FIRST (before star), then stats at right */}
                    {batchMode ? (
                      <div className="flex-shrink-0 w-5 flex items-center justify-center">
                        {isSelected
                          ? <CheckSquare size={14} className="text-ema" />
                          : <Square size={14} className="text-gray-300" />}
                      </div>
                    ) : (
                      <button onClick={e => openMenu(e, track.id)}
                        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 hover:bg-black/10 transition-all"
                        title="更多操作">
                        <MoreHorizontal size={14} />
                      </button>
                    )}

                    {/* Star */}
                    <button onClick={e => handleToggleFavorite(track, e)}
                      className="flex-shrink-0 p-0.5 rounded-full hover:scale-110 transition-transform"
                      title={track.is_favorited ? '取消收藏' : '添加收藏'}>
                      <Star size={13}
                        fill={track.is_favorited ? '#f59e0b' : 'none'}
                        className={track.is_favorited ? 'text-amber-400' : 'text-gray-300 group-hover:text-gray-400'} />
                    </button>

                    {/* Cover thumbnail */}
                    <div className="w-8 h-8 flex-shrink-0 rounded-lg overflow-hidden flex items-center justify-center bg-gray-100">
                      {track.cover_art
                        ? <img src={track.cover_art} alt="" className="w-full h-full object-cover" />
                        : <div className={`w-full h-full flex items-center justify-center text-sm
                              ${isActive && isPlaying ? 'bg-ema text-white' : 'bg-gray-100'}`}>
                            {isActive && isPlaying ? '▶' : '🎵'}
                          </div>
                      }
                    </div>

                    {/* Title + artist + last played */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate leading-snug">
                        <Highlighted text={track.title} query={searchQuery} />
                      </p>
                      <p className="text-xs text-theme-muted truncate leading-snug">
                        <Highlighted text={track.artist} query={searchQuery} />
                        {track.last_played && (
                          <span className="opacity-50"> · {formatRelativeTime(track.last_played)}</span>
                        )}
                      </p>
                    </div>

                    {/* Stats: play count + duration (Bug fix 1: these come AFTER "...") */}
                    <div className="flex items-center gap-2 text-xs text-theme-muted flex-shrink-0">
                      <span className="w-8 text-right flex items-center justify-end gap-0.5">
                        <Play size={9} className="opacity-50" />{track.play_count}
                      </span>
                      <span className="w-10 text-right font-mono">{formatTime(track.duration)}</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* ── Feature 6: Batch action bar ── */}
          {batchMode && (
            <div className="mt-3 pt-3 border-t border-ema/10 flex-shrink-0">
              {selectedIds.size === 0 ? (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-theme-muted">点击歌曲选择，或使用"全选"</p>
                  <button onClick={() => batchFileRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-xl border border-ema/20 hover:bg-ema/10 transition-colors">
                    <Upload size={12} /> 批量导入
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-theme-muted mr-0.5">已选 {selectedIds.size} 首：</span>

                  <button onClick={batchDownload}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl bg-blue-50 border border-blue-200 hover:bg-blue-100 text-blue-700 transition-colors">
                    <Download size={11} /> 下载
                  </button>

                  <button onClick={() => batchFavorite(true)}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl bg-amber-50 border border-amber-200 hover:bg-amber-100 text-amber-700 transition-colors">
                    <Star size={11} fill="currentColor" /> 收藏
                  </button>

                  <button onClick={() => batchFavorite(false)}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl bg-gray-50 border border-gray-200 hover:bg-gray-100 text-gray-600 transition-colors">
                    <Star size={11} /> 取消收藏
                  </button>

                  <div className="relative">
                    <button onClick={() => setShowBatchConvert(v => !v)} disabled={batchConverting}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl bg-green-50 border border-green-200 hover:bg-green-100 text-green-700 transition-colors disabled:opacity-50">
                      {batchConverting ? <Loader2 size={11} className="animate-spin" /> : <span>🔄</span>}
                      {batchConverting ? '转换中…' : '批量转换'}
                    </button>
                    {showBatchConvert && (
                      <div className="absolute bottom-full mb-2 left-0 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-100 dark:border-slate-700 p-3 z-40 min-w-[160px]">
                        <p className="text-xs text-theme-muted mb-2 font-medium">目标格式</p>
                        <div className="grid grid-cols-3 gap-1.5">
                          {CONVERT_FORMATS.map(fmt => (
                            <button key={fmt} onClick={() => batchConvertAll(fmt)}
                              className="px-2 py-1.5 text-xs font-medium rounded-lg bg-gray-50 hover:bg-ema hover:text-white transition-colors uppercase shadow-sm border border-gray-200">
                              {fmt}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <button onClick={batchDelete}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl bg-red-50 border border-red-200 hover:bg-red-100 text-red-600 transition-colors">
                    🗑 删除
                  </button>

                  <button onClick={() => batchFileRef.current?.click()}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl bg-ema/10 border border-ema/20 hover:bg-ema/20 text-ema transition-colors">
                    <Upload size={11} /> 批量导入
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════ */}
      {/* Play Mode Menu                            */}
      {/* ══════════════════════════════════════════ */}
      {showPlayModeMenu && playModeButtonRef.current && (() => {
        const rect = playModeButtonRef.current!.getBoundingClientRect()
        return (
          <div
            ref={playModeMenuRef}
            style={{ left: rect.left, top: rect.bottom + 6 }}
            className="fixed z-50 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-100 dark:border-slate-700 py-1.5 overflow-hidden min-w-[140px]">
            {PLAY_MODE_ORDER.map(mode => (
              <button
                key={mode}
                onClick={() => setPlayModeDirectly(mode)}
                className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-ema/10 transition-colors ${
                  playMode === mode ? 'bg-ema/5 text-ema font-medium' : ''
                }`}>
                {PLAY_MODE_META[mode].icon}
                <span>{PLAY_MODE_META[mode].label}</span>
                {playMode === mode && <span className="ml-auto text-ema">✓</span>}
              </button>
            ))}
          </div>
        )
      })()}

      {/* ══════════════════════════════════════════ */}
      {/* Context Menu (fixed, outside flex flow)   */}
      {/* ══════════════════════════════════════════ */}
      {openMenuId && menuTrack && (
        <div ref={menuRef}
          style={{ left: menuPos.x, top: menuPos.y, minWidth: 188 }}
          className="fixed z-50 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-100 dark:border-slate-700 py-1.5 overflow-hidden">
          <div>
            <button onClick={() => setShowConvertPanel(v => !v)}
              className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-ema/10 transition-colors">
              <span className="flex items-center gap-2"><span>🔄</span> 转换格式</span>
              <ChevronRight size={13} className={`transition-transform ${showConvertPanel ? 'rotate-90' : ''}`} />
            </button>
            {showConvertPanel && (
              <div className="bg-gray-50 dark:bg-slate-700/50 border-t border-b border-gray-100 dark:border-slate-600 py-1.5 px-3">
                <div className="grid grid-cols-3 gap-1">
                  {CONVERT_FORMATS.map(fmt => (
                    <button key={fmt} onClick={() => handleConvert(menuTrack, fmt)}
                      className="px-2 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-slate-600 hover:bg-ema hover:text-white transition-colors uppercase shadow-sm">
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button onClick={() => handleDownload(menuTrack)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-ema/10 transition-colors">
            <Download size={14} className="text-blue-500" /> 下载
          </button>
          <button onClick={() => handleDeleteTrack(menuTrack)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-red-50 transition-colors text-red-600">
            <Trash2 size={14} /> 删除
          </button>
          <div className="border-t border-gray-100 dark:border-slate-700 my-1" />
          <button onClick={() => openEditModal(menuTrack)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-ema/10 transition-colors">
            <Pencil size={14} className="text-green-500" /> 改名 &amp; 封面
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════ */}
      {/* Edit Modal                                */}
      {/* ══════════════════════════════════════════ */}
      {editingTrack && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setEditingTrack(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-96 p-6 mx-4"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold">编辑歌曲信息</h3>
              <button onClick={() => setEditingTrack(null)}
                className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="flex items-center gap-4 mb-5">
              <div onClick={() => coverInputRef.current?.click()}
                className="w-20 h-20 rounded-xl overflow-hidden bg-gradient-to-br from-ema/20 to-accent/20 flex items-center justify-center cursor-pointer hover:opacity-80 transition-opacity flex-shrink-0 border-2 border-dashed border-ema/30"
                title="点击更换封面">
                {editCoverPreview
                  ? <img src={editCoverPreview} alt="cover" className="w-full h-full object-cover" />
                  : <div className="text-center"><div className="text-2xl">🎵</div><div className="text-xs text-theme-muted mt-1">点击上传</div></div>}
              </div>
              <div>
                <p className="font-medium text-base truncate">{editingTrack.title}</p>
                <p className="text-xs text-theme-muted mt-1">点击左侧图片更换封面</p>
                <p className="text-xs text-theme-muted opacity-60 mt-0.5">支持 JPG / PNG / WebP</p>
              </div>
            </div>
            <div className="mb-3">
              <label className="text-xs font-medium text-theme-muted mb-1 block">歌曲名称</label>
              <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ema/30"
                placeholder="歌曲名称" />
            </div>
            <div className="mb-5">
              <label className="text-xs font-medium text-theme-muted mb-1 block">艺术家</label>
              <input type="text" value={editArtist} onChange={e => setEditArtist(e.target.value)}
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ema/30"
                placeholder="艺术家名称" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditingTrack(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 text-sm hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors">
                取消
              </button>
              <button onClick={handleSaveEdit} disabled={isSaving || !editTitle.trim()}
                className="flex-1 py-2.5 rounded-xl bg-ema text-white text-sm hover:bg-ema-dark disabled:opacity-50 transition-colors">
                {isSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
