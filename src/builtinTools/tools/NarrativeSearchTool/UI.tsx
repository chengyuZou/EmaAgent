// NarrativeSearchTool 的桌面展示: 事件驱动的剧情检索状态块 + 参数/结果卡。
// 状态块同时服务 SSE 流式(desktop 直接传 narrative_status slice 作 data)与持久化结果。
import { useState, type JSX } from 'react';
import { Button, Spinner } from '@ema-agent/ui';
import type { NarrativeSearchResult } from './NarrativeSearchTool.js';

/** 展示前显示的前 N 字(超长截断,点"展开全文"看全部)。 */
const PREVIEW_CHARS = 500;

/** 状态块视图模型: 与 desktop 的 narrative_status slice 同构, 流式/持久化共用。 */
export interface NarrativeStatusViewData {
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  timelines: string[];
  completedTimelines: string[];
  snippets: Record<string, string>;
  failedTimelines: Record<string, string>;
  message?: string;
}

/**
 * 剧情检索块。外层始终可折叠(header 切整块),双向动画。
 *   - 单周目:外层折叠,展开后直接显示那一个周目的内容(无内层子折叠)
 *   - 多周目:外层折叠 + 内层每个周目各自独立子折叠(双向动画)
 * 流式中按 timeline 完成状态实时更新;持久化后从 DB 重建(完整 text)。
 */
export function NarrativeStatusBlock({ data }: { data: NarrativeStatusViewData }): JSX.Element {
  const timelines = data.timelines;
  const completed = new Set(data.completedTimelines);
  const failed    = data.failedTimelines ?? {};
  const isMulti   = timelines.length > 1;
  const [outerOpen, setOuterOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--ema-info)] bg-[var(--ema-info-muted)] px-2.5 py-1.5 text-xs text-[var(--ema-text-tertiary)]"
         style={{ borderWidth: 1 }}>
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOuterOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left font-medium text-[var(--ema-info)] transition-colors hover:opacity-80"
        aria-expanded={outerOpen}
      >
        {data.status === 'running' && <Spinner size="sm" />}
        {data.status === 'completed' && (
          <span className="i-lucide:circle-check shrink-0 text-[var(--ema-info)]" aria-hidden />
        )}
        {data.status === 'failed' && (
          <span className="i-lucide:triangle-alert shrink-0 text-[var(--ema-warning)]" aria-hidden />
        )}
        {data.status === 'interrupted' && (
          <span className="i-lucide:circle-pause shrink-0 text-[var(--ema-warning)]" aria-hidden />
        )}
        <span className="flex-1">
          {narrativeStatusLabel(data, completed.size, Object.keys(failed).length)}
        </span>
        <span className={`${outerOpen ? 'i-lucide:chevron-down' : 'i-lucide:chevron-right'} text-[var(--ema-text-tertiary)]`} aria-hidden />
      </Button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: outerOpen ? '1fr' : '0fr', opacity: outerOpen ? 1 : 0 }}
      >
        <div className="flex flex-col gap-2">
          {(data.status === 'failed' || data.status === 'interrupted') && data.message && (
            <p className="text-xs text-[var(--ema-warning)]">{data.message}</p>
          )}
          {data.status === 'completed' && timelines.length === 0 && (
            <p className="text-xs italic text-[var(--ema-text-tertiary)]">
              未找到相关剧情资料
            </p>
          )}
          {timelines.map((name) => (
            <TimelineRow
              key={name}
              name={name}
              completed={completed.has(name)}
              error={failed[name]}
              text={data.snippets?.[name]}
              isMulti={isMulti}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 单个周目行: 单周目直接显示文本, 多周目各自独立子折叠(双向动画)。
 * 内容超 PREVIEW_CHARS 字: 预览前 N 字 + "展开全文"按钮。
 */
function TimelineRow({
  name, completed, error, text, isMulti,
}: {
  name:      string;
  completed: boolean;
  error:     string | undefined;
  text:      string | undefined;
  isMulti:   boolean;
}): JSX.Element {
  const [innerOpen, setInnerOpen] = useState(false);
  const [fullText, setFullText]   = useState(false);
  const settled = completed || error !== undefined;
  const hasFull   = !!text && text.length > PREVIEW_CHARS;
  const displayText = fullText ? text : (text?.slice(0, PREVIEW_CHARS) ?? '');

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="ghost"
        type="button"
        disabled={!isMulti || !settled}
        onClick={isMulti && settled ? () => setInnerOpen((v) => !v) : undefined}
        className="flex w-full items-center gap-1.5 text-left hover:opacity-80 disabled:cursor-default disabled:hover:opacity-100"
      >
        {error
          ? <span className="i-lucide:triangle-alert shrink-0 text-[var(--ema-warning)]" aria-hidden />
          : completed
          ? <span className="i-lucide:check shrink-0 text-[var(--ema-info)]" aria-hidden />
          : <span className="i-lucide:ellipsis shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
        }
        <span className={error ? 'text-[var(--ema-warning)]' : completed ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}>{name}</span>
        {isMulti && settled && (
          <span className={`ml-auto ${innerOpen ? 'i-lucide:chevron-down' : 'i-lucide:chevron-right'} text-[var(--ema-text-tertiary)]`} aria-hidden />
        )}
      </Button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: innerOpen || !isMulti ? '1fr' : '0fr', opacity: innerOpen || !isMulti ? 1 : 0 }}
      >
        {error ? (
          <p className="pl-5 text-xs text-[var(--ema-warning)]">检索失败：{error}</p>
        ) : completed && text ? (
          <div className="flex flex-col gap-1 pl-5">
            <div
              className={`ema-transition-text-expand ${fullText ? 'overflow-y-auto' : 'overflow-hidden'}`}
              style={{
                maxHeight: fullText ? '32rem' : '8rem',
                opacity:   fullText ? 1 : 0.92,
              }}
            >
              <p className="whitespace-pre-wrap break-words text-xs text-[var(--ema-text-tertiary)]">
                {displayText}
              </p>
            </div>
            {hasFull && !fullText && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => setFullText(true)}
                className="w-fit text-left text-[var(--ema-info)] hover:opacity-80"
              >
                …展开全文
              </Button>
            )}
            {hasFull && fullText && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => setFullText(false)}
                className="w-fit text-left text-[var(--ema-info)] hover:opacity-80"
              >
                收起全文
              </Button>
            )}
          </div>
        ) : completed ? (
          <p className="pl-5 text-xs italic text-[var(--ema-text-tertiary)]">
            （该剧情线未返回相关内容）
          </p>
        ) : null}
      </div>
    </div>
  );
}

function narrativeStatusLabel(
  data: NarrativeStatusViewData,
  completedCount: number,
  failedCount: number,
): string {
  if (data.status === 'running') return '检索剧情资料…';
  if (data.status === 'failed') return '剧情检索失败';
  if (data.status === 'interrupted') return '剧情检索已中断';
  if (data.timelines.length === 0) return '未找到相关剧情资料';
  if (failedCount > 0) {
    return `已检索 ${completedCount}/${data.timelines.length} 条剧情线`;
  }
  return `已检索 ${data.timelines.length} 条剧情线`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNarrativeSearchResult(data: unknown): NarrativeSearchResult | null {
  if (!isRecord(data) || !Array.isArray(data['timelines']) || !Array.isArray(data['failures'])) {
    return null;
  }
  if (typeof data['status'] !== 'string') return null;
  return data as unknown as NarrativeSearchResult;
}

export function NarrativeSearchArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['query'] !== 'string') return null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">query:</span>
      <span className="break-all text-[var(--ema-text-secondary)]">{args['query']}</span>
    </div>
  );
}

/** 结果卡: 把类型化 TOutput 投影成状态块视图, 供 Tool 注册表在普通结果卡中复用。 */
export function NarrativeSearchResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asNarrativeSearchResult(data);
  if (!result) return null;

  const view: NarrativeStatusViewData = result.status === 'unavailable'
    ? {
        status: 'failed',
        timelines: [],
        completedTimelines: [],
        snippets: {},
        failedTimelines: {},
        message: result.failures[0]?.message ?? '剧情检索不可用',
      }
    : {
        status: 'completed',
        timelines: result.timelines.map((timeline) => timeline.name),
        completedTimelines: result.timelines.map((timeline) => timeline.name),
        snippets: Object.fromEntries(
          result.timelines.map((timeline) => [timeline.name, timeline.text]),
        ),
        failedTimelines: Object.fromEntries(
          result.failures.map((failure) => [failure.timeline, failure.message]),
        ),
      };
  return <NarrativeStatusBlock data={view} />;
}
