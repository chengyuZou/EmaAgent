import { useState, useEffect, useRef, FormEvent } from 'react'
import { Upload, Gamepad2, Image as ImageIcon, Trash2, CheckSquare, Square } from 'lucide-react'
import PuzzleGame from './PuzzleGame'

const BACKEND_URL = 'http://localhost:8000'

const toApiUrl = (path: string) => `${BACKEND_URL}${path}`

const extractFilename = (src: string): string => {
  try {
    const parsed = new URL(src)
    const seg = parsed.pathname.split('/').filter(Boolean)
    return decodeURIComponent(seg[seg.length - 1] || '')
  } catch {
    const seg = src.split('/').filter(Boolean)
    return decodeURIComponent(seg[seg.length - 1] || '')
  }
}

export default function GamePage() {
  const [images, setImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set())
  
  // 选中的图片 URL (如果非空，则进入游戏模式)
  const [playingImage, setPlayingImage] = useState<string | null>(null)
  
  const fileRef = useRef<HTMLInputElement | null>(null)

  const fetchImages = async () => {
    try {
      const res = await fetch(toApiUrl('/api/game/images'))
      const data = await res.json()
      if (Array.isArray(data)) {
        const normalized = data.map((src: string) => 
          src.startsWith('http') ? src : `${BACKEND_URL}${src}`
        )
        setImages(normalized)
        setSelectedImages(prev => new Set([...prev].filter(src => normalized.includes(src))))
        if (playingImage && !normalized.includes(playingImage)) {
          setPlayingImage(null)
        }
      }
    } catch (err) {
      console.error('加载拼图素材失败', err)
    }
  }

  useEffect(() => { fetchImages() }, [playingImage])

  const handleUpload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) return
    
    setUploading(true)
    const data = new FormData()
    data.append('file', file)
    
    try {
      const res = await fetch(toApiUrl('/api/game/upload'), { 
        method: 'POST', 
        body: data 
      })
      const result = await res.json()
      if (result.url) {
        fetchImages() // 刷新列表
        // 可选：上传完直接开始玩
        // setPlayingImage(`http://localhost:8000${result.url}`)
      }
    } catch(e) {
      console.error(e)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
      setUploading(false)
    }
  }

  const toggleSelectImage = (src: string) => {
    setSelectedImages(prev => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src)
      else next.add(src)
      return next
    })
  }

  const toggleBatchMode = () => {
    setBatchMode(prev => {
      if (prev) setSelectedImages(new Set())
      return !prev
    })
  }

  const deleteSingleImage = async (src: string, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const filename = extractFilename(src)
    if (!filename) return
    if (!confirm(`确定删除图片 ${filename} 吗？`)) return

    setDeleting(true)
    try {
      const res = await fetch(toApiUrl(`/api/game/image/${encodeURIComponent(filename)}`), {
        method: 'DELETE',
      })
      if (!res.ok) {
        alert('删除失败')
        return
      }
      await fetchImages()
    } catch (err) {
      console.error('删除拼图失败', err)
      alert('删除失败，请检查后端服务')
    } finally {
      setDeleting(false)
    }
  }

  const batchDeleteImages = async () => {
    if (selectedImages.size === 0) return
    if (!confirm(`确定删除选中的 ${selectedImages.size} 张图片吗？`)) return

    setDeleting(true)
    try {
      const res = await fetch(toApiUrl('/api/game/images/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: Array.from(selectedImages) }),
      })
      if (!res.ok) {
        alert('批量删除失败')
        return
      }
      setSelectedImages(new Set())
      await fetchImages()
    } catch (err) {
      console.error('批量删除拼图失败', err)
      alert('批量删除失败，请检查后端服务')
    } finally {
      setDeleting(false)
    }
  }

  // 如果正在游戏中，渲染游戏组件
  if (playingImage) {
    return (
      <div className="h-full w-full p-4">
        <PuzzleGame 
          imageUrl={playingImage} 
          onBack={() => setPlayingImage(null)} 
        />
      </div>
    )
  }

  // 否则渲染选图界面
  return (
    <div className="h-full flex flex-col p-6 overflow-hidden">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-3 text-white">
            <Gamepad2 className="text-ema" size={32} />
            拼图挑战
          </h2>
          <p className="text-slate-400 mt-1">选择一张图片开始游戏，或者上传你喜欢的图片</p>
        </div>

        <form onSubmit={handleUpload} className="flex items-center gap-3 bg-black/20 p-1.5 rounded-xl border border-white/5">
          <input 
            ref={fileRef} 
            type="file" 
            name="file" 
            accept="image/*" 
            className="text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-white/10 file:text-white hover:file:bg-white/20 cursor-pointer" 
          />
          <button 
            type="submit" 
            className="bg-ema hover:bg-ema-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            disabled={uploading}
          >
            {uploading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Upload size={16} />}
            上传
          </button>
          <button
            type="button"
            onClick={toggleBatchMode}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
              batchMode
                ? 'bg-amber-500/20 text-amber-200 border-amber-400/40 hover:bg-amber-500/30'
                : 'bg-white/5 text-slate-200 border-white/10 hover:bg-white/10'
            }`}
          >
            {batchMode ? '取消批量' : '批量删除'}
          </button>
          {batchMode && (
            <button
              type="button"
              onClick={batchDeleteImages}
              disabled={deleting || selectedImages.size === 0}
              className="bg-red-500/80 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <Trash2 size={15} />
              删除选中 ({selectedImages.size})
            </button>
          )}
        </form>
      </header>

      <div className="flex-1 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-700">
        {images.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-slate-500 border-2 border-dashed border-slate-700 rounded-2xl">
            <ImageIcon size={48} className="mb-4 opacity-50" />
            <p>暂无图片，请上传</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
            {images.map((src, idx) => {
              const isSelected = selectedImages.has(src)
              return (
                <div
                  key={src}
                  className="group relative aspect-[4/3] bg-black/40 rounded-xl overflow-hidden cursor-pointer border border-white/5 hover:border-ema/50 hover:shadow-lg hover:shadow-ema/10 transition-all duration-300 hover:-translate-y-1"
                  onClick={() => batchMode ? toggleSelectImage(src) : setPlayingImage(src)}
                >
                  <img
                    src={src}
                    alt={`Puzzle ${idx}`}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                    loading="lazy"
                  />
                  <button
                    type="button"
                    onClick={(e) => deleteSingleImage(src, e)}
                    disabled={deleting}
                    className="absolute top-2 right-2 z-20 w-8 h-8 rounded-lg bg-black/55 text-red-200 hover:text-white hover:bg-red-500/80 border border-white/10 flex items-center justify-center transition-colors disabled:opacity-50"
                    title="删除图片"
                  >
                    <Trash2 size={14} />
                  </button>
                  {batchMode && (
                    <div className="absolute top-2 left-2 z-20">
                      {isSelected
                        ? <CheckSquare size={18} className="text-emerald-300" />
                        : <Square size={18} className="text-white/80" />}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
                    <span className="text-white font-medium text-sm flex items-center gap-2">
                      <Gamepad2 size={14} /> {batchMode ? (isSelected ? '已选择' : '点击选择') : '开始游戏'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
