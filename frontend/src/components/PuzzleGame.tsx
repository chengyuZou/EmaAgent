import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, RefreshCw, Trophy, Clock, Image as ImageIcon, ZoomIn, ZoomOut } from 'lucide-react'

interface PuzzleGameProps {
  imageUrl: string
  onBack: () => void
}

interface Tile {
  currentPos: number // 当前在数组中的索引
  correctPos: number // 正确的索引位置 (ID)
}

export default function PuzzleGame({ imageUrl, onBack }: PuzzleGameProps) {
  // 游戏配置
  const [gridSize, setGridSize] = useState(3) // N x N
  const [scale, setScale] = useState(1) // 缩放比例 (0.5 - 2.0)
  const [isGameStarted, setIsGameStarted] = useState(false)
  
  // 游戏状态
  const [tiles, setTiles] = useState<Tile[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [isSolved, setIsSolved] = useState(false)
  
  // 计时与统计
  const [, setTimer] = useState(0)
  const timerRef = useRef<number | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [finalTime, setFinalTime] = useState('0.00')

  // 图片尺寸适配
  const [imgRatio, setImgRatio] = useState(1) // 宽/高

  // 1. 加载图片并计算比例 (防止拉伸)
  useEffect(() => {
    const img = new Image()
    img.src = imageUrl
    img.onload = () => {
      const ratio = img.width / img.height
      setImgRatio(ratio)
      
    }
  }, [imageUrl])

  // 2. 初始化游戏
  const initGame = () => {
    // 生成瓦片
    const total = gridSize * gridSize
    const newTiles: Tile[] = Array.from({ length: total }, (_, i) => ({
      currentPos: i,
      correctPos: i
    }))

    // 随机打乱 (Fisher-Yates)
    // 确保打乱后的位置与原位置不同，或者直接完全随机
    for (let i = newTiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      // 交换
      const temp = newTiles[i]
      newTiles[i] = newTiles[j]
      newTiles[j] = temp
    }

    setTiles(newTiles)
    setSelectedIdx(null)
    setIsSolved(false)
    setIsGameStarted(true)
    
    // 重置计时器
    if (timerRef.current) clearInterval(timerRef.current)
    setTimer(0)
    setStartTime(Date.now())
    timerRef.current = window.setInterval(() => {
      setTimer((Date.now() - startTime) / 1000)
    }, 100)
  }

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // 启动时的逻辑修正：startTime 需要在点击开始时更新
  useEffect(() => {
    if (isGameStarted) {
      const start = Date.now()
      setStartTime(start)
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = window.setInterval(() => {
        setTimer((Date.now() - start) / 1000)
      }, 100)
    }
  }, [isGameStarted])

  // 3. 点击交互逻辑
  const handleTileClick = (index: number) => {
    if (isSolved) return

    // 如果没选中，就选中当前
    if (selectedIdx === null) {
      setSelectedIdx(index)
      return
    }

    // 如果点击了同一个，取消选中
    if (selectedIdx === index) {
      setSelectedIdx(null)
      return
    }

    // 如果点击了另一个 -> 交换!
    swapTiles(selectedIdx, index)
    setSelectedIdx(null)
  }

  const swapTiles = (idxA: number, idxB: number) => {
    const newTiles = [...tiles]
    // 交换数组元素
    const temp = newTiles[idxA]
    newTiles[idxA] = newTiles[idxB]
    newTiles[idxB] = temp
    
    setTiles(newTiles)
    checkWin(newTiles)
  }

  const checkWin = (currentTiles: Tile[]) => {
    // 检查每一个瓦片的 correctPos 是否等于它的当前索引
    const isWin = currentTiles.every((tile, index) => tile.correctPos === index)
    
    if (isWin) {
      setIsSolved(true)
      if (timerRef.current) clearInterval(timerRef.current)
      setFinalTime(((Date.now() - startTime) / 1000).toFixed(2))
    }
  }

  // 鼠标滚轮缩放
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1 // 向下缩小，向上放大
    setScale(prev => Math.max(0.5, Math.min(2.0, prev + delta)))
  }

  // 计算背景图位置
  // 核心难点：如何在乱序的 grid 中显示正确的图片切片？
  // 答案：每个 Tile 记录了自己应该是哪一块 (correctPos)。
  // 我们根据 correctPos 计算 backgroundPosition。
  const getTileStyle = (tile: Tile) => {
    const row = Math.floor(tile.correctPos / gridSize)
    const col = tile.correctPos % gridSize
    
    // 背景大小：如果是 3x3，背景要是格子的 300%
    const bgSize = `${gridSize * 100}%`
    
    // 背景位置偏移
    const xPos = (col / (gridSize - 1)) * 100
    const yPos = (row / (gridSize - 1)) * 100
    
    // 修正：当 gridSize=1 时分母为0，不过游戏最小是2
    // 使用百分比定位在 CSS background-position 中非常方便
    
    return {
      backgroundImage: `url(${imageUrl})`,
      backgroundSize: bgSize,
      backgroundPosition: `${xPos}% ${yPos}%`,
    }
  }

  return (
    <div className="h-full flex flex-col gap-4 relative">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between bg-white/5 p-4 rounded-xl backdrop-blur-sm border border-white/10">
        <div className="flex items-center gap-4">
          <button 
            onClick={onBack}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors flex items-center gap-2 text-slate-300 hover:text-white"
          >
            <ArrowLeft size={20} />
            <span>退出</span>
          </button>
          
          <div className="h-6 w-px bg-white/10" />
          
          {!isGameStarted ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-400">选择难度:</span>
              <select 
                value={gridSize}
                onChange={(e) => setGridSize(Number(e.target.value))}
                className="bg-black/30 border border-white/10 rounded-lg px-3 py-1 text-sm outline-none focus:border-ema"
              >
                <option value={3}>3 x 3</option>
                <option value={4}>4 x 4</option>
                <option value={5}>5 x 5</option>
                <option value={8}>8 x 8</option>
                <option value={10}>10 x 10</option>
                <option value={20}>20 x 20</option>
              </select>
              <button 
                onClick={initGame}
                className="px-4 py-1.5 bg-ema hover:bg-ema-dark text-white text-sm rounded-lg transition-colors font-medium"
              >
                开始挑战
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <span className="text-slate-300 font-mono text-lg flex items-center gap-2">
                <Clock size={18} className="text-ema" />
                {((Date.now() - startTime) / 1000).toFixed(1)}s
              </span>
              <button 
                onClick={initGame}
                className="p-2 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors"
                title="重新洗牌"
              >
                <RefreshCw size={18} />
              </button>
              
              {/* 缩放控制 */}
              <div className="flex items-center gap-2">
                <ZoomOut 
                  size={16} 
                  className="text-slate-400 cursor-pointer hover:text-white transition-colors" 
                  onClick={() => setScale(Math.max(0.5, scale - 0.1))}
                />
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                  className="w-20 h-2 bg-black/30 rounded-lg appearance-none cursor-pointer slider"
                  title={`缩放: ${(scale * 100).toFixed(0)}%`}
                />
                <ZoomIn 
                  size={16} 
                  className="text-slate-400 cursor-pointer hover:text-white transition-colors" 
                  onClick={() => setScale(Math.min(2.0, scale + 0.1))}
                />
                <span className="text-xs text-slate-400 w-8">{(scale * 100).toFixed(0)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 游戏主区域 */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden bg-black/20 rounded-2xl relative">
        {!isGameStarted ? (
          <div className="text-center text-slate-400">
            <ImageIcon size={64} className="mx-auto mb-4 opacity-20" />
            <p>请选择难度并点击"开始挑战"</p>
          </div>
        ) : (
          <div 
            className="relative shadow-2xl transition-all duration-500"
            style={{
              // 核心：自适应图片比例 + 缩放
              aspectRatio: `${imgRatio}`,
              width: imgRatio > 1 ? 'min(100%, 800px)' : 'auto',
              height: imgRatio <= 1 ? 'min(100%, 600px)' : 'auto',
              display: 'grid',
              gridTemplateColumns: `repeat(${gridSize}, 1fr)`,
              gap: '1px', // 拼图缝隙
              backgroundColor: '#1e1e1e',
              border: '4px solid #333',
              transform: `scale(${scale})`,
              transformOrigin: 'center',
            }}
            onWheel={handleWheel}
          >
            {tiles.map((tile, idx) => (
              <div
                key={idx}
                onClick={() => handleTileClick(idx)}
                className={`
                  relative w-full h-full cursor-pointer transition-all duration-200
                  ${selectedIdx === idx ? 'z-10 ring-2 ring-yellow-400 brightness-110 scale-[0.98]' : 'hover:brightness-110'}
                  ${isSolved ? 'ring-0 cursor-default' : ''}
                `}
                style={getTileStyle(tile)}
              />
            ))}
          </div>
        )}

        {/* 右下角原图预览 (悬浮) */}
        {isGameStarted && !isSolved && (
          <div className="absolute bottom-4 right-4 w-32 md:w-48 aspect-video group z-20">
            <div className="w-full h-full rounded-lg overflow-hidden border-2 border-white/20 shadow-xl bg-black transition-all group-hover:scale-150 origin-bottom-right">
              <img src={imageUrl} className="w-full h-full object-contain opacity-80 group-hover:opacity-100" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-0 transition-opacity">
                <span className="text-xs text-white">按住预览</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 胜利结算弹窗 */}
      {isSolved && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in rounded-2xl">
          <div className="bg-[#252526] p-8 rounded-2xl border border-white/10 shadow-2xl flex flex-col items-center gap-4 max-w-sm w-full transform animate-bounce-in">
            <div className="w-20 h-20 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-full flex items-center justify-center shadow-lg shadow-orange-500/20 mb-2">
              <Trophy size={40} className="text-white" />
            </div>
            
            <h2 className="text-2xl font-bold text-white">拼图完成!</h2>
            
            <div className="flex flex-col items-center gap-1 text-slate-300">
              <p>耗时</p>
              <p className="text-4xl font-mono font-bold text-ema">{finalTime} <span className="text-lg">s</span></p>
            </div>

            <div className="flex gap-3 w-full mt-4">
              <button 
                onClick={onBack}
                className="flex-1 py-3 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 transition-colors"
              >
                返回列表
              </button>
              <button 
                onClick={initGame}
                className="flex-1 py-3 rounded-xl bg-ema hover:bg-ema-dark text-white font-bold transition-colors shadow-lg shadow-ema/20"
              >
                再玩一次
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
