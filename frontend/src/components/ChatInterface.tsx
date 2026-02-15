import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Send, Volume2, VolumeX, PlayCircle, Paperclip, X, Square, Copy, Check, ChevronDown } from 'lucide-react'
import EmaLive2D from './EmaLive2D'

interface Message {
  id: string
  text: string
  sender: 'user' | 'assistant'
  audioUrl?: string
  isTyping?: boolean
  timestamp: Date
}

interface ModelOption {
  id: string
  label: string
  enabled: boolean
  provider?: string
}

type ChatMode = 'chat' | 'agent' | 'narrative'

interface UploadedAttachment {
  id: string
  name: string
  saved_name: string
  saved_path: string
  url: string
  size: number
  content_type: string
  text_excerpt?: string
}

interface ChatInterfaceProps {
  activeSessionId: string | null
  onSessionCreated?: (sessionId: string) => void
  skipHistoryLoad?: { current: boolean }
}

interface MarkdownSegment {
  type: 'text' | 'code'
  content: string
  language?: string
}

const MODEL_GROUPS: Array<{ title: string; ids: string[] }> = [
  {
    title: 'DeepSeek',
    ids: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    title: 'Qwen',
    ids: ['qwen3-max', 'qwen-plus', 'qwen-flash', 'qwen-max', 'qwen3-coder-plus', 'qwen3-coder-flash'],
  },
  {
    title: 'OpenAI',
    ids: ['gpt-4o', 'gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3', 'gpt-5.2-codex', 'gpt-5.3-codex'],
  },
]

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const renderInlineMarkdown = (value: string): string => {
  let text = escapeHtml(value)
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer" class="text-ema underline underline-offset-2">$1</a>',
  )
  text = text.replace(/`([^`\n]+)`/g, '<code class="px-1 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[0.92em]">$1</code>')
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return text
}

const renderMarkdownHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listMode: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listMode === 'ul') html.push('</ul>')
    if (listMode === 'ol') html.push('</ol>')
    listMode = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line) {
      closeList()
      html.push('<div class="h-2"></div>')
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = Math.min(6, heading[1].length)
      const content = renderInlineMarkdown(heading[2])
      html.push(`<h${level} class="font-semibold mt-2 mb-1">${content}</h${level}>`)
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      closeList()
      html.push(
        `<blockquote class="border-l-4 border-slate-300 dark:border-slate-600 pl-3 my-1 text-slate-600 dark:text-slate-300">${renderInlineMarkdown(quote[1])}</blockquote>`,
      )
      continue
    }

    const ul = line.match(/^[-*+]\s+(.*)$/)
    if (ul) {
      if (listMode !== 'ul') {
        closeList()
        html.push('<ul class="list-disc pl-5 my-1 space-y-1">')
        listMode = 'ul'
      }
      html.push(`<li>${renderInlineMarkdown(ul[1])}</li>`)
      continue
    }

    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (ol) {
      if (listMode !== 'ol') {
        closeList()
        html.push('<ol class="list-decimal pl-5 my-1 space-y-1">')
        listMode = 'ol'
      }
      html.push(`<li>${renderInlineMarkdown(ol[1])}</li>`)
      continue
    }

    closeList()
    html.push(`<p class="my-1">${renderInlineMarkdown(line)}</p>`)
  }

  closeList()
  return html.join('')
}

const splitMarkdownSegments = (text: string): MarkdownSegment[] => {
  const regex = /```([a-zA-Z0-9_+.#-]*)\n?([\s\S]*?)```/g
  const segments: MarkdownSegment[] = []
  let lastIndex = 0

  let match = regex.exec(text)
  while (match) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }

    segments.push({
      type: 'code',
      language: (match[1] || 'text').trim() || 'text',
      content: (match[2] || '').replace(/\n$/, ''),
    })

    lastIndex = regex.lastIndex
    match = regex.exec(text)
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) })
  }

  if (segments.length === 0) {
    return [{ type: 'text', content: text }]
  }

  return segments
}

export default function ChatInterface({
  activeSessionId,
  onSessionCreated,
  skipHistoryLoad,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState('')
  const [isGlobalTyping, setIsGlobalTyping] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [switchingModel, setSwitchingModel] = useState(false)
  const [selectedMode, setSelectedMode] = useState<ChatMode>('chat')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [copiedKeys, setCopiedKeys] = useState<Record<string, boolean>>({})
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  const chatContainerRef = useRef<HTMLDivElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioQueueRef = useRef<string[]>([])
  const isPlayingRef = useRef(false)
  const audioEnabledRef = useRef(audioEnabled)
  const ws = useRef<WebSocket | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  useEffect(() => {
    audioEnabledRef.current = audioEnabled
  }, [audioEnabled])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false)
      }
      if (modelMenuRef.current && !modelMenuRef.current.contains(target)) {
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  const selectedModelInfo = useMemo(
    () => models.find((m) => m.id === selectedModel),
    [models, selectedModel],
  )

  const groupedModels = useMemo(() => {
    const modelMap = new Map(models.map((m) => [m.id, m]))
    const groups = MODEL_GROUPS
      .map((group) => ({
        title: group.title,
        items: group.ids.map((id) => modelMap.get(id)).filter(Boolean) as ModelOption[],
      }))
      .filter((group) => group.items.length > 0)

    const known = new Set(MODEL_GROUPS.flatMap((group) => group.ids))
    const others = models.filter((m) => !known.has(m.id))
    if (others.length > 0) {
      groups.push({ title: '其它', items: others })
    }

    return groups
  }, [models])

  useEffect(() => {
    const fetchModels = async () => {
      try {
        const res = await fetch('http://localhost:8000/api/settings/models')
        if (!res.ok) return
        const data = await res.json()
        setModels((data.models || []) as ModelOption[])
        setSelectedModel(data.selected_model || '')
      } catch (e) {
        console.error('加载模型列表失败:', e)
      }
    }
    fetchModels()
  }, [])

  useEffect(() => {
    if (activeSessionId === null) {
      setMessages([])
      setIsGlobalTyping(false)
      setAttachments([])
      setShowScrollToBottom(false)
      shouldAutoScrollRef.current = true
      return
    }

    if (skipHistoryLoad?.current) {
      return
    }

    const fetchHistory = async () => {
      try {
        const res = await fetch(`http://localhost:8000/api/sessions/${activeSessionId}/messages`)
        if (!res.ok) return
        const data = await res.json()
        const history = data.messages.map((m: any, idx: number) => ({
          id: `hist-${idx}`,
          text: m.content,
          sender: m.role as 'user' | 'assistant',
          audioUrl: m.audio_url || undefined,
          timestamp: new Date(m.timestamp || Date.now()),
        }))
        setMessages(history)
      } catch (e) {
        console.error('加载历史失败:', e)
      }
    }
    fetchHistory()
  }, [activeSessionId, skipHistoryLoad])

  useEffect(() => {
    const connectWs = () => {
      const socket = new WebSocket('ws://localhost:8000/api/ws/chat')

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          const requestId = data.request_id as string | undefined
          const activeRequestId = activeRequestIdRef.current

          if (requestId && activeRequestId && requestId !== activeRequestId) {
            return
          }

          if (data.type === 'token') {
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1]
              if (lastMsg && lastMsg.sender === 'assistant') {
                if (lastMsg.isTyping) {
                  return [...prev.slice(0, -1), { ...lastMsg, text: data.content, isTyping: false }]
                }
                return [...prev.slice(0, -1), { ...lastMsg, text: lastMsg.text + data.content, isTyping: false }]
              }
              return prev
            })
            return
          }

          if (data.type === 'audio') {
            if (audioEnabledRef.current) queueAudio(data.url)
            return
          }

          if (data.type === 'done') {
            setIsGlobalTyping(false)
            activeRequestIdRef.current = null
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.sender === 'assistant' && last.isTyping) {
                const stoppedText = data.stopped ? '已停止。' : last.text
                return [...prev.slice(0, -1), { ...last, text: stoppedText, isTyping: false }]
              }
              return prev
            })
            if (data.full_audio_url) {
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                if (last && last.sender === 'assistant') {
                  return [...prev.slice(0, -1), { ...last, audioUrl: data.full_audio_url, isTyping: false }]
                }
                return prev
              })
            }
            return
          }

          if (data.type === 'error') {
            setIsGlobalTyping(false)
            activeRequestIdRef.current = null
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.sender === 'assistant' && last.isTyping) {
                return [...prev.slice(0, -1), { ...last, text: `错误: ${data.message}`, isTyping: false }]
              }
              return prev
            })
            return
          }
        } catch (e) {
          console.error(e)
        }
      }

      socket.onclose = () => {
        setTimeout(connectWs, 1000)
      }

      ws.current = socket
    }

    connectWs()
    return () => ws.current?.close()
  }, [])

  const updateScrollState = useCallback(() => {
    const el = chatContainerRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    const nearBottom = distanceToBottom < 80
    shouldAutoScrollRef.current = nearBottom
    setShowScrollToBottom(!nearBottom)
  }, [])

  useEffect(() => {
    const el = chatContainerRef.current
    if (!el) return
    if (!shouldAutoScrollRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, isGlobalTyping])

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      audioContextRef.current = new Ctx()
    }
    return audioContextRef.current
  }, [])

  const normalizeAudioUrl = (url: string) => {
    if (!url) return ''
    if (url.startsWith('http')) return url
    const clean = url.replace(/\\/g, '/')
    const filename = clean.split('/').pop()
    if (!filename) return `http://localhost:8000/${clean.replace(/^\/?/, '')}`
    if (clean.includes('/output/')) return `http://localhost:8000/audio/output/${filename}`
    if (clean.includes('/cache/')) return `http://localhost:8000/audio/cache/${filename}`
    return `http://localhost:8000/audio/${filename}`
  }

  const stopAudioPlayback = () => {
    audioQueueRef.current = []
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current.currentTime = 0
      currentAudioRef.current = null
    }
    isPlayingRef.current = false
    if (window.emaLive2D) window.emaLive2D.setMouth(0)
  }

  const queueAudio = (url: string) => {
    if (!url) return
    audioQueueRef.current.push(normalizeAudioUrl(url))
    void processAudioQueue()
  }

  const processAudioQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return
    isPlayingRef.current = true
    const url = audioQueueRef.current.shift()
    if (url) await playAudio(url)
  }

  const handleReplay = async (url: string) => {
    if (!url || !audioEnabledRef.current) return
    await playAudio(normalizeAudioUrl(url), true)
  }

  const playAudio = async (url: string, forcePlay = false) => {
    const fullUrl = normalizeAudioUrl(url)
    try {
      const ctx = getAudioContext()
      if (ctx.state === 'suspended') await ctx.resume()

      const audio = new Audio(fullUrl)
      currentAudioRef.current = audio
      audio.crossOrigin = 'anonymous'

      const source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)
      analyser.connect(ctx.destination)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      let animationId = 0
      let lastMouthValue = 0

      const updateMouth = () => {
        if (audio.paused || audio.ended) return
        analyser.getByteFrequencyData(dataArray)
        const startBin = Math.floor(300 / 86)
        const endBin = Math.floor(3000 / 86)
        let sum = 0
        let count = 0
        for (let i = startBin; i < Math.min(endBin, dataArray.length); i++) {
          sum += dataArray[i]
          count++
        }
        const avg = count > 0 ? sum / count : 0
        const raw = Math.min(1, Math.pow(avg / 80, 0.9))
        const mouth = lastMouthValue + (raw - lastMouthValue) * 0.4
        lastMouthValue = mouth
        if (window.emaLive2D) window.emaLive2D.setMouth(mouth)
        animationId = requestAnimationFrame(updateMouth)
      }

      await audio.play().catch(() => {
        audio.oncanplaythrough = () => void audio.play()
      })
      updateMouth()

      await new Promise<void>((resolve) => {
        audio.onended = () => {
          cancelAnimationFrame(animationId)
          if (window.emaLive2D) window.emaLive2D.setMouth(0)
          currentAudioRef.current = null
          if (!forcePlay) {
            isPlayingRef.current = false
            void processAudioQueue()
          }
          resolve()
        }
      })
    } catch (e) {
      console.error('播放出错:', e)
      currentAudioRef.current = null
      if (!forcePlay) {
        isPlayingRef.current = false
        void processAudioQueue()
      }
    }
  }

  const createRequestId = () => `req_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return

    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    if (activeSessionId) {
      formData.append('session_id', activeSessionId)
    }

    try {
      setIsUploading(true)
      const res = await fetch('http://localhost:8000/api/chat/upload', {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        console.error('上传失败:', await res.text())
        return
      }
      const data = await res.json()
      const newAttachments = (data.attachments || []) as UploadedAttachment[]
      setAttachments((prev) => [...prev, ...newAttachments])
    } catch (e) {
      console.error('上传失败:', e)
    } finally {
      setIsUploading(false)
    }
  }

  const handleFileInputChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    await uploadFiles(Array.from(fileList))
    e.target.value = ''
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (!files.length) return
    await uploadFiles(files)
  }

  const handleSendMessage = async () => {
    const hasText = !!inputText.trim()
    const hasAttachments = attachments.length > 0
    if (!hasText && !hasAttachments) return

    const userDisplay = hasText ? inputText : '[上传了附件]'
    const attachmentInfo = hasAttachments
      ? `\n\n[附件]\n${attachments.map((a) => `- ${a.name}`).join('\n')}`
      : ''

    const userMsg: Message = {
      id: Date.now().toString(),
      text: `${userDisplay}${attachmentInfo}`,
      sender: 'user',
      timestamp: new Date(),
    }
    const placeholderMsg: Message = {
      id: `ai-${Date.now()}`,
      text: '正在回答...',
      sender: 'assistant',
      timestamp: new Date(),
      isTyping: true,
    }
    setMessages((prev) => [...prev, userMsg, placeholderMsg])
    setIsGlobalTyping(true)

    let targetSessionId = activeSessionId

    if (targetSessionId === null) {
      try {
        const newSessionName = (inputText || 'new_chat').slice(0, 20).replace(/[/\\?%*:|"<>]/g, '-')
        const res = await fetch('http://localhost:8000/api/sessions/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: newSessionName }),
        })
        if (!res.ok) {
          console.error('创建会话失败:', await res.text())
          setIsGlobalTyping(false)
          setMessages((prev) => prev.slice(0, -2))
          return
        }
        const data = await res.json()
        targetSessionId = data.session_id
        if (onSessionCreated && targetSessionId) onSessionCreated(targetSessionId)
        await new Promise((resolve) => setTimeout(resolve, 200))
      } catch (e) {
        console.error('创建会话失败:', e)
        setIsGlobalTyping(false)
        setMessages((prev) => prev.slice(0, -2))
        return
      }
    }

    const requestId = createRequestId()
    activeRequestIdRef.current = requestId

    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(
        JSON.stringify({
          type: 'message',
          request_id: requestId,
          content: inputText,
          session_id: targetSessionId,
          mode: selectedMode,
          attachments,
          audio_enabled: audioEnabled,
        }),
      )
    }

    try {
      const ctx = getAudioContext()
      if (ctx.state === 'suspended') await ctx.resume()
    } catch (_) {}

    setInputText('')
    setAttachments([])
  }

  const handleStop = () => {
    const requestId = activeRequestIdRef.current
    if (requestId && ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'stop', request_id: requestId }))
    }
    stopAudioPlayback()
  }

  const handleModelChange = async (modelId: string) => {
    if (!modelId || modelId === selectedModel) return
    try {
      setSwitchingModel(true)
      const res = await fetch('http://localhost:8000/api/settings/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      })
      if (!res.ok) {
        console.error('切换模型失败:', await res.text())
        return
      }
      setSelectedModel(modelId)
    } catch (e) {
      console.error('切换模型失败:', e)
    } finally {
      setSwitchingModel(false)
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }

    setCopiedKeys((prev) => ({ ...prev, [key]: true }))
    window.setTimeout(() => {
      setCopiedKeys((prev) => ({ ...prev, [key]: false }))
    }, 1300)
  }

  return (
    <div className="flex h-full bg-theme-bg overflow-hidden relative">
      <div className="flex-1 flex flex-col relative z-10 mr-[400px] h-full min-h-0">
        {messages.length === 0 && activeSessionId === null ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
            <div className="w-16 h-16 rounded-full overflow-hidden border border-pink-300/70 shadow-sm">
              <img src="/ema.png" alt="ema" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-2xl font-bold text-slate-700 dark:text-slate-200">你好，我是艾玛</h2>
            <p className="text-slate-400 dark:text-slate-500 text-sm max-w-xs">发送一条消息开始新的对话</p>
          </div>
        ) : (
          <div className="relative flex-1 min-h-0">
            <div
              ref={chatContainerRef}
              onScroll={updateScrollState}
              className="h-full overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-gray-700"
            >
            {messages.map((msg) => {
              const isAssistant = msg.sender === 'assistant'
              const fullCopyKey = `${msg.id}-full`
              const segments = isAssistant ? splitMarkdownSegments(msg.text) : []

              return (
                <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`relative max-w-[85%] rounded-2xl px-5 py-3.5 shadow-sm text-[15px] leading-relaxed group transition-all break-words ${
                      msg.sender === 'user'
                        ? 'bg-ema text-white rounded-br-none'
                        : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-bl-none border border-slate-100 dark:border-slate-700'
                    } ${msg.isTyping ? 'animate-pulse opacity-80 italic text-slate-500' : ''}`}
                  >
                    {isAssistant && !msg.isTyping && (
                      <button
                        onClick={() => void copyText(fullCopyKey, msg.text)}
                        className="absolute top-2 right-2 p-1.5 rounded-md text-slate-400 hover:text-ema hover:bg-slate-100 dark:hover:bg-slate-700 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="复制全文"
                      >
                        {copiedKeys[fullCopyKey] ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    )}

                    <div className="space-y-2">
                      {isAssistant ? (
                        segments.map((segment, idx) =>
                          segment.type === 'code' ? (
                            <div
                              key={`${msg.id}-code-${idx}`}
                              className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-950/90 text-slate-100"
                            >
                              <div className="flex items-center justify-between px-3 py-1.5 text-xs bg-slate-900/95 border-b border-slate-700">
                                <span className="uppercase tracking-wide text-slate-300">{segment.language || 'text'}</span>
                                <button
                                  onClick={() => void copyText(`${msg.id}-code-${idx}`, segment.content)}
                                  className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
                                  title="复制代码"
                                >
                                  {copiedKeys[`${msg.id}-code-${idx}`] ? <Check size={13} /> : <Copy size={13} />}
                                  <span>{copiedKeys[`${msg.id}-code-${idx}`] ? '已复制' : '复制'}</span>
                                </button>
                              </div>
                              <pre className="p-3 overflow-x-auto text-[13px] leading-relaxed">
                                <code>{segment.content}</code>
                              </pre>
                            </div>
                          ) : (
                            <div
                              key={`${msg.id}-md-${idx}`}
                              className="markdown-body"
                              dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(segment.content) }}
                            />
                          ),
                        )
                      ) : (
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      )}
                    </div>

                    {msg.sender === 'assistant' && msg.audioUrl && !msg.isTyping && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleReplay(msg.audioUrl!)
                        }}
                        className="absolute -bottom-8 right-0 p-1.5 text-slate-400 hover:text-ema hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-all cursor-pointer opacity-70 hover:opacity-100"
                        title="重播语音"
                      >
                        <PlayCircle size={18} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            </div>

            {showScrollToBottom && (
              <button
                type="button"
                onClick={() => {
                  const el = chatContainerRef.current
                  if (!el) return
                  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                  shouldAutoScrollRef.current = true
                  setShowScrollToBottom(false)
                }}
                className="absolute right-4 bottom-4 w-8 h-8 rounded-full bg-ema text-white shadow-md hover:bg-ema-dark transition-colors flex items-center justify-center"
                title="回到底部"
              >
                ↓
              </button>
            )}
          </div>
        )}

        <div className="p-3 border-t border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          <div className="w-full space-y-3">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm"
                  >
                    <span className="truncate max-w-[180px]" title={a.name}>
                      {a.name}
                    </span>
                    <button
                      onClick={() => removeAttachment(a.id)}
                      className="text-slate-400 hover:text-red-500"
                      title="移除附件"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => void handleDrop(e)}
              className={`rounded-3xl px-3 py-2 bg-slate-100/85 dark:bg-slate-800/85 border border-slate-200/70 dark:border-slate-700/70 min-h-[106px] ${
                dragOver ? 'ring-2 ring-ema/60 bg-ema/5' : ''
              }`}
            >
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSendMessage()
                  }
                }}
                placeholder={isGlobalTyping ? '正在回答中...' : '和艾玛聊天，或拖拽上传附件...'}
                disabled={isGlobalTyping}
                className="w-full flex-1 min-h-[58px] bg-transparent text-slate-900 dark:text-slate-100 rounded-none px-1.5 py-1.5 resize-none focus:outline-none border-none disabled:opacity-60"
                rows={2}
              />

              <div className="mt-1.5 flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading || isGlobalTyping}
                    className="w-7 h-7 rounded-full text-slate-500 hover:text-ema bg-slate-100/80 dark:bg-slate-700/70 disabled:opacity-50 border border-slate-300/70 dark:border-slate-600/70 flex items-center justify-center"
                    title="添加附件"
                  >
                    <Paperclip size={11} />
                  </button>

                  <button
                    onClick={() => setAudioEnabled(!audioEnabled)}
                    className={`h-7 px-2 rounded-lg transition-colors flex items-center gap-1 border ${
                      audioEnabled
                        ? 'text-ema bg-slate-100/80 dark:bg-slate-700/70 border-ema/25'
                        : 'text-slate-500 bg-slate-100/80 dark:bg-slate-700/70 border-slate-300 dark:border-slate-600'
                    }`}
                    title={audioEnabled ? '关闭TTS声音' : '开启TTS声音'}
                  >
                    {audioEnabled ? <Volume2 size={10} /> : <VolumeX size={10} />}
                    <span className="text-xs">{audioEnabled ? 'TTS开' : 'TTS关'}</span>
                  </button>

                  <div className="relative" ref={modeMenuRef}>
                    <button
                      type="button"
                      onClick={() => {
                        if (isGlobalTyping) return
                        setModeMenuOpen((prev) => !prev)
                        setModelMenuOpen(false)
                      }}
                      disabled={isGlobalTyping}
                      className="h-7 px-2 rounded-lg bg-slate-100/80 dark:bg-slate-700/70 text-slate-900 dark:text-slate-100 border border-slate-300/70 dark:border-slate-600/70 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
                      title="选择模式"
                    >
                      <span>
                        {selectedMode === 'chat' ? 'Chat' : selectedMode === 'agent' ? 'Agent' : 'Narrative'}
                      </span>
                      <ChevronDown size={12} className={`${modeMenuOpen ? 'rotate-180' : ''} transition-transform`} />
                    </button>

                    {modeMenuOpen && !isGlobalTyping && (
                      <div className="absolute left-0 bottom-[calc(100%+6px)] z-30 min-w-[126px] p-1.5 rounded-xl border border-slate-300/70 dark:border-slate-600/70 bg-slate-100/95 dark:bg-slate-800/95 backdrop-blur-sm shadow-lg">
                        {([
                          { key: 'chat', label: 'Chat' },
                          { key: 'agent', label: 'Agent' },
                          { key: 'narrative', label: 'Narrative' },
                        ] as Array<{ key: ChatMode; label: string }>).map((mode) => (
                          <button
                            key={mode.key}
                            type="button"
                            onClick={() => {
                              setSelectedMode(mode.key)
                              setModeMenuOpen(false)
                            }}
                            className={`w-full h-7 px-2 rounded-lg text-left text-sm inline-flex items-center justify-between ${
                              selectedMode === mode.key
                                ? 'bg-ema/15 text-ema'
                                : 'text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700/70'
                            }`}
                          >
                            <span>{mode.label}</span>
                            {selectedMode === mode.key && <Check size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <div className="relative" ref={modelMenuRef}>
                    <button
                      type="button"
                      onClick={() => {
                        if (isGlobalTyping || switchingModel) return
                        setModelMenuOpen((prev) => !prev)
                        setModeMenuOpen(false)
                      }}
                      disabled={isGlobalTyping || switchingModel}
                      className="h-7 px-2 bg-slate-100/80 dark:bg-slate-700/70 text-slate-900 dark:text-slate-100 rounded-lg border border-slate-300/70 dark:border-slate-600/70 inline-flex items-center gap-1.5 disabled:opacity-60 max-w-[190px] text-sm"
                      title="选择模型"
                    >
                      <span className="truncate max-w-[150px]">
                        {models.length === 0 ? '模型加载中...' : selectedModelInfo?.label || selectedModel || '选择模型'}
                      </span>
                      <ChevronDown size={12} className={`${modelMenuOpen ? 'rotate-180' : ''} transition-transform`} />
                    </button>

                    {modelMenuOpen && !isGlobalTyping && !switchingModel && (
                      <div className="absolute left-0 bottom-[calc(100%+6px)] z-30 w-[260px] max-h-[280px] overflow-y-auto p-1.5 rounded-xl border border-slate-300/70 dark:border-slate-600/70 bg-slate-100/95 dark:bg-slate-800/95 backdrop-blur-sm shadow-lg">
                        {groupedModels.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-slate-500">暂无模型</div>
                        ) : (
                          groupedModels.map((group, groupIdx) => (
                            <div key={group.title} className={groupIdx > 0 ? 'mt-1.5 pt-1.5 border-t border-slate-300/70 dark:border-slate-600/70' : ''}>
                              {group.items.map((m) => (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => {
                                    if (!m.enabled) return
                                    setModelMenuOpen(false)
                                    void handleModelChange(m.id)
                                  }}
                                  className={`w-full h-7 px-2 rounded-lg text-left text-sm inline-flex items-center justify-between ${
                                    selectedModel === m.id
                                      ? 'bg-ema/15 text-ema'
                                      : 'text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700/70'
                                  } ${m.enabled ? '' : 'opacity-60 cursor-not-allowed'}`}
                                >
                                  <span className="truncate pr-2">
                                    {m.label}
                                    {m.enabled ? '' : ' (缺少Key)'}
                                  </span>
                                  {selectedModel === m.id && <Check size={12} />}
                                </button>
                              ))}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {isGlobalTyping ? (
                    <button
                      onClick={handleStop}
                      className="w-7 h-7 bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors shadow-sm flex items-center justify-center"
                      title="停止生成"
                    >
                      <Square size={10} />
                    </button>
                  ) : (
                    <button
                      onClick={() => void handleSendMessage()}
                      disabled={(!inputText.trim() && attachments.length === 0) || isUploading}
                      className="w-7 h-7 bg-ema hover:bg-ema-dark text-white rounded-full transition-colors disabled:opacity-50 shadow-sm flex items-center justify-center"
                      title="发送"
                    >
                      <Send size={10} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute top-0 right-0 bottom-0 w-[400px] z-20 pointer-events-none">
        <div className="w-full h-full relative pointer-events-auto">
          <EmaLive2D />
        </div>
      </div>
    </div>
  )
}

