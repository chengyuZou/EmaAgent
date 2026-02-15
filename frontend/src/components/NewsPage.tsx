import { useState, useEffect, useCallback } from 'react'
import '../styles/NewsPage.css'

interface NewsItem {
  id: string
  title: string
  url: string
  source: string
  source_label: string
  thumbnail: string
  date: string
  author: string
  description: string
  category: string
  category_label: string
  play_count?: number
  danmaku_count?: number
  duration?: string
  bvid?: string
  character?: string
  character_name?: string
}

interface SourceInfo { id: string; name: string; icon: string }
interface CharacterInfo { id: string; name: string; name_jp: string }
interface PreferenceLog { id: string; message: string; timestamp: string }

const LIMIT_OPTIONS = [50, 100, 150, 200]

export default function NewsPage() {
  const [news, setNews] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [sources, setSources] = useState<SourceInfo[]>([])
  const [characters, setCharacters] = useState<CharacterInfo[]>([])

  const [activeSource, setActiveSource] = useState('bilibili')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(100)
  const [queryText, setQueryText] = useState('')

  const [prefCharacters, setPrefCharacters] = useState<string[]>([])
  const [prefLogs, setPrefLogs] = useState<PreferenceLog[]>([])
  const [showPreferences, setShowPreferences] = useState(false)

  useEffect(() => {
    fetchMeta()
  }, [])

  useEffect(() => {
    // First load: default source bilibili + empty input.
    doFetch('bilibili', 1, false)
  }, [])

  const fetchMeta = async () => {
    try {
      const [srcRes, charRes] = await Promise.all([
        fetch('/api/news/sources'),
        fetch('/api/news/characters'),
      ])
      if (srcRes.ok) setSources(await srcRes.json())
      if (charRes.ok) setCharacters(await charRes.json())
    } catch (e) {
      console.warn('⚠️ 元数据加载失败', e)
    }
  }

  const doFetch = useCallback(async (
    source: string,
    targetPage: number,
    includePreferences: boolean,
  ) => {
    setLoading(true)
    setError('')

    try {
      const params = new URLSearchParams({
        source,
        query: queryText.trim(),
        limit: String(perPage),
        page: String(targetPage),
      })

      if (includePreferences) {
        if (prefCharacters.length) params.set('preferred_characters', prefCharacters.join(','))
      }

      const res = await fetch(`/api/news?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      setNews(data)
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [perPage, prefCharacters, queryText])

  const hasPreferences = prefCharacters.length > 0

  const handleSourceChange = (srcId: string) => {
    setActiveSource(srcId)
    setPage(1)
    doFetch(srcId, 1, hasPreferences)
  }

  const handleRefresh = () => {
    setPage(1)
    doFetch(activeSource, 1, hasPreferences)
  }

  const handleSearch = () => {
    setPage(1)
    doFetch(activeSource, 1, hasPreferences)
  }

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
    doFetch(activeSource, newPage, hasPreferences)
    document.querySelector('.news-scroll-area')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const pushPrefLog = (message: string) => {
    const now = new Date()
    const time = now.toLocaleTimeString('zh-CN', { hour12: false })
    const item: PreferenceLog = {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      message,
      timestamp: time,
    }
    setPrefLogs(prev => [item, ...prev].slice(0, 20))
  }

  const togglePref = (
    list: string[],
    setList: (v: string[]) => void,
    value: string,
    label: string,
    typeLabel: string,
  ) => {
    if (list.includes(value)) {
      setList(list.filter(v => v !== value))
      pushPrefLog(`移除${typeLabel}: ${label}`)
    } else {
      setList([...list, value])
      pushPrefLog(`添加${typeLabel}: ${label}`)
    }
  }

  const applyPreferences = () => {
    setShowPreferences(false)
    setPage(1)
    doFetch(activeSource, 1, hasPreferences)
  }

  const clearPreferences = () => {
    setPrefCharacters([])
    pushPrefLog('清空全部偏好字段')
  }

  const formatCount = (n?: number) => {
    if (!n) return ''
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
    return String(n)
  }

  return (
    <div className="news-page">
      <div className="news-header">
        <div className="news-controls-row">
          <div className="news-controls-left">
            <div className="news-search-box">
              <input
                type="text"
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearch()
                }}
                className="news-search-input"
                placeholder="请输入关键词"
              />
            </div>

            <button onClick={handleSearch} className="news-search-btn news-refresh-btn">搜索</button>
            <button onClick={handleRefresh} className="news-search-btn news-refresh-btn">刷新</button>

            <button
              onClick={() => setShowPreferences(!showPreferences)}
              className={`news-pref-btn ${showPreferences ? 'active' : ''}`}
            >
              ⚙️ 偏好
              {(prefCharacters.length > 0) && (
                <span className="pref-badge">{prefCharacters.length}</span>
              )}
            </button>
          </div>

          <div className="news-controls-right">
            <div className="news-limit-box">
              <label htmlFor="news-limit-select">显示条数</label>
              <select
                id="news-limit-select"
                value={perPage}
                onChange={(e) => setPerPage(parseInt(e.target.value, 10))}
                className="news-limit-input"
              >
                {LIMIT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>

            <div className="news-strategy-tip">
              {!hasPreferences ? '当前策略: 固定前缀 + 输入关键词 100%' : '当前策略: 角色偏好 70% + 固定前缀关键词 30%'}
            </div>
          </div>
        </div>
      </div>

      {showPreferences && (
        <div className="pref-panel">
          <div className="pref-section">
            <h4>👤 角色偏好 <span className="pref-hint">（点击后加入偏好关键词）</span></h4>
            <div className="pref-tags character-tags">
              {characters.map(ch => (
                <button
                  key={ch.id}
                  className={`pref-tag ${prefCharacters.includes(ch.id) ? 'selected' : ''}`}
                  onClick={() => togglePref(prefCharacters, setPrefCharacters, ch.id, ch.name, '角色')}
                >{ch.name}</button>
              ))}
            </div>
          </div>

          <div className="pref-actions">
            <button className="pref-apply" onClick={applyPreferences}>✅ 应用偏好并搜索</button>
            <button className="pref-clear" onClick={clearPreferences}>清空全部</button>
          </div>

          <div className="pref-log-box">
            <div className="pref-log-title">字段变更记录</div>
            {prefLogs.length === 0 ? (
              <div className="pref-log-empty">暂无字段变更记录</div>
            ) : (
              <ul className="pref-log-list">
                {prefLogs.map(log => (
                  <li key={log.id}><span>{log.timestamp}</span><span>{log.message}</span></li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="news-source-tabs">
        {sources.filter(s => s.id !== 'all').map(s => (
          <button
            key={s.id}
            className={`source-tab ${activeSource === s.id ? 'active' : ''}`}
            onClick={() => handleSourceChange(s.id)}
          >{s.icon} {s.name}</button>
        ))}
      </div>

      {loading && (
        <div className="news-loading">
          <div className="loading-spinner" />
          <span>正在抓取资讯...</span>
        </div>
      )}

      {error && (
        <div className="news-error">
          ❌ {error}
          <button onClick={handleRefresh}>重试</button>
        </div>
      )}

      {!loading && !error && news.length === 0 && (
        <div className="news-empty">暂无资讯，稍后重试。</div>
      )}

      <div className="news-scroll-area">
        <div className="news-count">
          {!loading && news.length > 0 && `共 ${news.length} 条结果`}
        </div>
        <div className="news-grid">
          {news.map(item => (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`news-card ${item.source}`}
            >
              {item.thumbnail ? (
                <div className="news-card-thumb">
                  <img
                    src={item.thumbnail}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  {item.duration && <span className="thumb-duration">{item.duration}</span>}
                </div>
              ) : (
                <div className="news-card-thumb placeholder">
                  <span>{
                    item.source === 'bilibili' ? '📺' :
                    item.source === 'baidu' ? '🔵' :
                    item.source === 'google' ? '🔍' : '📰'
                  }</span>
                </div>
              )}

              <div className="news-card-body">
                <h3 className="news-card-title">{item.title}</h3>

                <div className="news-card-meta">
                  <span className={`meta-source tag-${item.source}`}>{item.source_label}</span>
                  {item.character_name && <span className="meta-character">👤 {item.character_name}</span>}
                </div>

                {item.description && (
                  <p className="news-card-desc">{item.description}</p>
                )}

                <div className="news-card-info">
                  {item.author && <span className="info-author">@{item.author}</span>}
                  {item.date && <span className="info-date">{item.date}</span>}
                </div>

                {item.source === 'bilibili' && (item.play_count || 0) > 0 && (
                  <div className="news-card-stats">
                    <span>▶ {formatCount(item.play_count)}</span>
                    {(item.danmaku_count || 0) > 0 && <span>💬 {formatCount(item.danmaku_count)}</span>}
                  </div>
                )}
              </div>
            </a>
          ))}
        </div>
      </div>

      {news.length >= 10 && (
        <div className="news-pagination">
          <button disabled={page <= 1} onClick={() => handlePageChange(page - 1)}>← 上一页</button>
          <span className="page-num">第 {page} 页</span>
          <button onClick={() => handlePageChange(page + 1)}>下一页 →</button>
        </div>
      )}
    </div>
  )
}
