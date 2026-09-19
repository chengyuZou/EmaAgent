// NarrativeSearchTool 的桌面参数与结果展示. 运行状态由通用 Tool 块负责, 检索内容在结果落盘后显示.
import { useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { NarrativeQueryMode } from '@ema-agent/narrative';
import type { NarrativeSearchResult } from './NarrativeSearchTool.js';

/** 展示前 N 个字符. 内容更长时允许用户展开全文. */
const PREVIEW_CHARS = 500;

/** 检索模式的中文标签. NarrativeQueryMode 增加成员时这里必须同批补齐. */
const NARRATIVE_MODE_LABELS: Record<NarrativeQueryMode, string> = {
  local: '局部',
  global: '全局',
  hybrid: '混合',
  naive: '向量',
  mix: '图谱',
};

/**
 * 剧情检索结果可以整体折叠.
 * 单周目展开后直接显示正文, 多周目再为每个周目提供独立折叠.
 * Tool 完成后从类型化结果显示正文. Tool 是否仍在运行以及调用本身是否失败由外层 Tool 块显示.
 */
function NarrativeResultBlock({ result }: { result: NarrativeSearchResult }): JSX.Element {
  const completed = new Set(result.timelines.map((timeline) => timeline.name));
  const snippets = Object.fromEntries(
    result.timelines.map((timeline) => [timeline.name, timeline.text]),
  );
  const failed = Object.fromEntries(
    result.failures.map((failure) => [failure.timeline, failure.message]),
  );
  const timelines = [
    ...result.timelines.map((timeline) => timeline.name),
    ...result.failures
      .map((failure) => failure.timeline)
      .filter((name) => !completed.has(name)),
  ];
  const isFailed = result.status === 'unavailable';
  const isMulti = timelines.length > 1;
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
        {!isFailed && (
          <span className="i-lucide:circle-check shrink-0 text-[var(--ema-info)]" aria-hidden />
        )}
        {isFailed && (
          <span className="i-lucide:triangle-alert shrink-0 text-[var(--ema-warning)]" aria-hidden />
        )}
        <span className="flex-1">
          {narrativeResultLabel(result, timelines.length)}
        </span>
        <span className={`${outerOpen ? 'i-lucide:chevron-down' : 'i-lucide:chevron-right'} text-[var(--ema-text-tertiary)]`} aria-hidden />
      </Button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: outerOpen ? '1fr' : '0fr', opacity: outerOpen ? 1 : 0 }}
      >
        <div className="flex flex-col gap-2">
          {isFailed && (
            <p className="text-xs text-[var(--ema-warning)]">
              {result.failures[0]?.message ?? '剧情检索不可用'}
            </p>
          )}
          {!isFailed && timelines.length === 0 && (
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
              text={snippets[name]}
              isMulti={isMulti}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 单周目直接显示正文, 多周目各自独立折叠.
 * 正文超过 PREVIEW_CHARS 个字符时先显示预览, 用户可以继续展开全文.
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
  const hasFull   = !!text && text.length > PREVIEW_CHARS;
  const displayText = fullText ? text : (text?.slice(0, PREVIEW_CHARS) ?? '');

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="ghost"
        type="button"
        disabled={!isMulti}
        onClick={isMulti ? () => setInnerOpen((v) => !v) : undefined}
        className="flex w-full items-center gap-1.5 text-left hover:opacity-80 disabled:cursor-default disabled:hover:opacity-100"
      >
        {error
          ? <span className="i-lucide:triangle-alert shrink-0 text-[var(--ema-warning)]" aria-hidden />
          : <span className="i-lucide:check shrink-0 text-[var(--ema-info)]" aria-hidden />
        }
        <span className={error ? 'text-[var(--ema-warning)]' : completed ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}>{name}</span>
        {isMulti && (
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

function narrativeResultLabel(result: NarrativeSearchResult, timelineCount: number): string {
  if (result.status === 'unavailable') return '剧情检索失败';
  if (timelineCount === 0) return '未找到相关剧情资料';
  if (result.failures.length > 0) {
    return `已检索 ${result.timelines.length}/${timelineCount} 条剧情线`;
  }
  return `已检索 ${timelineCount} 条剧情线`;
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
  const mode = typeof args['mode'] === 'string' ? args['mode'] : undefined;
  const modeLabel = mode && mode in NARRATIVE_MODE_LABELS
    ? NARRATIVE_MODE_LABELS[mode as NarrativeQueryMode]
    : mode;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">query:</span>
      <span className="break-all text-[var(--ema-text-secondary)]">{args['query']}</span>
      {modeLabel && (
        <span className="ml-auto shrink-0 rounded-full bg-[var(--ema-info-muted)] px-1.5 py-0.5 text-[10px] text-[var(--ema-info)]">
          {modeLabel}
        </span>
      )}
    </div>
  );
}

/** Tool 完成后直接显示 NarrativeSearchResult, 不再转换成第二套流式状态. */
export function NarrativeSearchResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asNarrativeSearchResult(data);
  if (!result) return null;
  return <NarrativeResultBlock result={result} />;
}
