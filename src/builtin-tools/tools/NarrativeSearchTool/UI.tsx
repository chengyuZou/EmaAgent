import { useId, useMemo, useState, type JSX } from 'react';
import { Button, Markdown } from '@ema-agent/ui';
import type { NarrativeTimelineId } from '@ema-agent/storage';
import type { NarrativeSearchResult } from './NarrativeSearchTool.js';

const TIMELINE_LABELS: Record<NarrativeTimelineId, string> = {
  '1st_Loop': '第一周目',
  '2nd_Loop': '第二周目',
  '3rd_Loop': '第三周目',
};

function NarrativeResultBlock({ result }: { result: NarrativeSearchResult }): JSX.Element {
  const texts = new Map(result.timelines
    .filter(timeline => timeline.text.trim().length > 0)
    .map(timeline => [timeline.name, timeline.text]));
  const failures = new Map(result.failures.map(failure => [failure.timeline, failure.message]));
  const names = (Object.keys(TIMELINE_LABELS) as NarrativeTimelineId[])
    .filter(name => texts.has(name) || failures.has(name));
  const firstContent = names.find(name => texts.has(name) && !failures.has(name));

  return (
    <div className="ema-narrative-results">
      {names.length === 0 ? (
        <p className="ema-narrative-empty">未找到相关剧情资料</p>
      ) : names.map(name => (
        <TimelineRow
          key={name}
          name={name}
          text={texts.get(name)}
          error={failures.get(name)}
          initiallyOpen={name === firstContent || names.length === 1}
        />
      ))}
    </div>
  );
}

function TimelineRow({ name, text, error, initiallyOpen }: {
  name: NarrativeTimelineId;
  text: string | undefined;
  error: string | undefined;
  initiallyOpen: boolean;
}): JSX.Element {
  const bodyId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [raw, setRaw] = useState(false);
  // 首次展开才渲染 Markdown. 收起时保留正文完成高度动画, 再次展开也不用重新挂载.
  // 外层 Tool 收起后会卸载整个结果区, 不跨工具调用保留正文.
  const [bodyMounted, setBodyMounted] = useState(initiallyOpen);
  const chunks = useMemo(() => narrativeChunks(text ?? ''), [text]);

  return (
    <section className="ema-narrative-timeline">
      <Button
        variant="ghost"
        size="sm"
        className="ema-narrative-timeline-trigger"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setBodyMounted(true);
          setOpen(value => !value);
        }}
      >
        <span className="i-lucide:chevron-right ema-narrative-chevron" aria-hidden />
        <span>{TIMELINE_LABELS[name]}</span>
        {error !== undefined && <span className="ema-narrative-error-label">Error</span>}
      </Button>
      <div
        id={bodyId}
        className="ema-collapsible ema-narrative-collapse"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
        aria-hidden={!open}
        ref={element => {
          if (element) element.inert = !open;
        }}
      >
        <div>
          {bodyMounted && (
            <div className="ema-narrative-body">
              {error !== undefined ? (
                <pre className="ema-narrative-error-detail" role="alert">{error}</pre>
              ) : (
                <>
                  {chunks !== null && (
                    <div className="ema-narrative-body-toolbar">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ema-narrative-raw-toggle"
                        aria-pressed={raw}
                        onClick={() => setRaw(value => !value)}
                      >
                        {raw ? '返回正文' : '原始输出'}
                      </Button>
                    </div>
                  )}
                  {raw ? (
                    <pre className="ema-narrative-raw">{text}</pre>
                  ) : (
                    <Markdown
                      source={chunks?.join('\n\n') ?? text ?? ''}
                      className="ema-tool-result-markdown ema-narrative-markdown"
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// buildContext 的每个正文块占一行 JSON, 换行保存在 content 的转义字符串里.
// 只拆现有 content 用于阅读; 没有正文块或格式无法读取时显示完整原文, 不丢掉图背景.
function narrativeChunks(text: string): string[] | null {
  const chunks: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"reference_id":')) continue;
    try {
      const chunk: unknown = JSON.parse(line);
      if (!isRecord(chunk) || typeof chunk['content'] !== 'string') return null;
      chunks.push(chunk['content']);
    } catch {
      return null;
    }
  }
  return chunks.length > 0 ? chunks : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNarrativeSearchResult(data: unknown): NarrativeSearchResult | null {
  if (!isRecord(data) || !Array.isArray(data['timelines']) || !Array.isArray(data['failures'])) {
    return null;
  }
  if (!['found', 'partial', 'empty', 'unavailable'].includes(String(data['status']))) return null;
  if (!data['timelines'].every(timeline => isRecord(timeline)
    && typeof timeline['name'] === 'string'
    && Object.hasOwn(TIMELINE_LABELS, timeline['name'])
    && typeof timeline['text'] === 'string')) return null;
  if (!data['failures'].every(failure => isRecord(failure)
    && typeof failure['timeline'] === 'string'
    && Object.hasOwn(TIMELINE_LABELS, failure['timeline'])
    && typeof failure['message'] === 'string')) return null;
  return data as unknown as NarrativeSearchResult;
}

export function narrativeSearchResultCopyText(data: unknown): string | null {
  const result = asNarrativeSearchResult(data);
  if (!result) return null;
  // 阅读视图可能只显示正文, 复制仍保留工具返回的图背景、所有正文和失败说明.
  const timelines = result.timelines.map(timeline => `${timeline.name}\n${timeline.text}`);
  const failures = result.failures.map(failure => `${failure.timeline}\n${failure.message}`);
  return [...timelines, ...failures].join('\n\n') || '未找到相关剧情资料';
}

export function NarrativeSearchResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asNarrativeSearchResult(data);
  if (!result) return null;
  return <NarrativeResultBlock result={result} />;
}
