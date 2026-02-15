import React, { useEffect, useRef, useState } from 'react'


declare global {
  interface Window {
    emaLive2D?: {
      setExpression: (expr: string) => void
      setMouth: (value: number) => void
      setViewMode: (mode: 'half' | 'full') => void
    }
  }
}

interface EmaLive2DProps {
  className?: string
}

const EmaLive2D: React.FC<EmaLive2DProps> = ({ className = '' }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentExpression, setCurrentExpression] = useState('normal')
  const [viewMode, setViewMode] = useState<'half' | 'full'>('half') // 默认半身

  // 1. 监听 iframe 消息 (加载状态)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return

      if (event.data.type === 'live2d_ready') {
        console.log('✅ Live2D 视觉模块就绪')
        setLoading(false)
        // 初始化时发送一次视图模式
        iframeRef.current?.contentWindow?.postMessage({ type: 'view_mode', value: 'half' }, '*')
      } else if (event.data.type === 'live2d_error') {
        setError(event.data.message || '加载失败')
        setLoading(false)
      }
    }
    
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // 2. 核心：全局鼠标视线追踪
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!iframeRef.current) return;

      // 计算归一化坐标 (范围 -1.0 到 1.0)
      // Live2D 的 focus 方法需要这样的坐标系
      const x = (e.clientX / window.innerWidth) * 2 - 1;
      const y = (e.clientY / window.innerHeight) * 2 - 1;

      // 发送给 iframe
      iframeRef.current.contentWindow?.postMessage({
        type: 'pointer_move',
        x,
        y: -y // Live2D Y轴通常是反的，或者根据实际观感调整
      }, '*');
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // 3. 挂载全局控制方法 (供 ChatInterface 使用)
  useEffect(() => {
    window.emaLive2D = {
      setExpression: (expr: string) => {
        setCurrentExpression(expr)
        iframeRef.current?.contentWindow?.postMessage({ type: 'expression', value: expr }, '*')
      },
      setMouth: (value: number) => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'mouth', value }, '*')
      },
      setViewMode: (mode: 'half' | 'full') => {
        setViewMode(mode)
        iframeRef.current?.contentWindow?.postMessage({ type: 'view_mode', value: mode }, '*')
      }
    }
  }, [])

  const handleViewMode = (mode: 'half' | 'full') => {
    setViewMode(mode)
    iframeRef.current?.contentWindow?.postMessage({ type: 'view_mode', value: mode }, '*')
  }

  const handleExpression = (expr: string) => {
    setCurrentExpression(expr)
    iframeRef.current?.contentWindow?.postMessage({ type: 'expression', value: expr }, '*')
  }

  // 表情配置
  const expressions = [
    { key: 'normal', label: '默认', color: 'bg-blue-500/80' },
    { key: 'taishou', label: '抬手', color: 'bg-emerald-500/80' },
    { key: 'liulei', label: '流泪', color: 'bg-indigo-500/80' },
    { key: 'monvhua', label: '魔女化', color: 'bg-rose-500/80' }
  ]

  return (
    <div className={`relative w-full h-full ${className}`}>
      <iframe
        ref={iframeRef}
        src="/live2d-viewer.html"
        className="w-full h-full border-none pointer-events-none" // 允许点击穿透
        title="Ema Live2D"
        scrolling="no"
      />

      {/* 加载提示 */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/50 text-white px-4 py-2 rounded-full backdrop-blur-sm text-sm animate-pulse">
            ✨ Live2D加载中...
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="absolute bottom-20 left-4 right-4 bg-red-500/90 text-white p-3 rounded-lg text-xs pointer-events-auto">
          Live2D 加载错误: {error}
        </div>
      )}

      {/* ✅ 右上角：视图切换按钮 */}
      <div className="absolute top-4 right-4 flex gap-2 pointer-events-auto z-50">
        <button
          onClick={() => handleViewMode('half')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium backdrop-blur-md transition-all border
            ${viewMode === 'half' 
              ? 'bg-violet-500/90 text-white border-violet-400/50 shadow-lg shadow-violet-500/30' 
              : 'bg-black/30 text-white/70 border-white/10 hover:bg-black/50'
            }`}
        >
          半身
        </button>
        <button
          onClick={() => handleViewMode('full')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium backdrop-blur-md transition-all border
            ${viewMode === 'full' 
              ? 'bg-violet-500/90 text-white border-violet-400/50 shadow-lg shadow-violet-500/30' 
              : 'bg-black/30 text-white/70 border-white/10 hover:bg-black/50'
            }`}
        >
          全身
        </button>
      </div>

      {/* ✅ 左下角：表情按钮 */}
      <div className="absolute bottom-5 left-5 flex gap-2 pointer-events-auto z-50">
        {expressions.map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => handleExpression(key)}
            className={`
              ${color} text-white text-xs font-medium 
              px-3 py-1.5 rounded-lg shadow-lg backdrop-blur-sm 
              transition-all active:scale-95 border border-white/10
              ${currentExpression === key ? 'ring-2 ring-white/80 scale-105' : 'opacity-80 hover:opacity-100'}
            `}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default EmaLive2D