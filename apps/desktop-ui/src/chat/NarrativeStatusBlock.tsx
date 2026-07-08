import { useState } from 'react';
import { Spinner } from '@ema-agent/ui';
import type { AssistantSlice } from '../stores/conversation-store.js';

type NarrativeSlice = Extract<AssistantSlice, { type: 'narrative_status' }>;

/** 展开前显示的前 N 字(超长截断,点"展开全文"看全部) */
const PREVIEW_CHARS = 500;

/**
 * narrative 检索块。外层始终可折叠(header 切整块),双向动画。
 *   - 单周目:外层折叠,展开后直接显示那一个周目的内容(无内层子折叠)
 *   - 多周目:外层折叠 + 内层每个周目各自独立子折叠(双向动画)
 * 流式中按 timeline 完成状态实时更新;持久化后从 DB 重建(完整 text)。
 * 间距统一:header -> 周目列表、各周目行之间,任何状态都等间距。
 */
export function NarrativeStatusBlock({ slice }: { slice: NarrativeSlice }): React.JSX.Element {
  const timelines = slice.timelines;
  const completed = new Set(slice.completedTimelines);
  const allDone   = timelines.length > 0 && completed.size >= timelines.length;
  const isMulti   = timelines.length > 1;

  // 外层折叠 state:单/多周目都默认收起,用户主动展开
  const [outerOpen, setOuterOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 text-xs rounded-lg px-2.5 py-1.5"
         style={{ color: 'var(--ema-text-tertiary)', background: 'var(--ema-info-muted)', borderColor: 'var(--ema-info)', borderWidth: 1 }}>

      {/* header:始终可点击折叠 */}
      <button
        type="button"
        onClick={() => setOuterOpen((v) => !v)}
        className="flex items-center gap-1.5 font-medium transition-colors text-left w-full hover:opacity-80"
        style={{ color: 'var(--ema-info)' }}
        aria-expanded={outerOpen}
      >
        {allDone
          ? <span className="i-mdi:check-circle-outline shrink-0" style={{ color: 'var(--ema-info)' }} aria-hidden />
          : <Spinner size="sm" />
        }
        <span className="flex-1">
          {allDone ? `已检索 ${timelines.length} 条剧情线` : '检索剧情线…'}
        </span>
        <span style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden>{outerOpen ? '▼' : '▶'}</span>
      </button>

      {/* 外层折叠区:ema-collapsible 双向动画。内层 gap-2 与 header 间距一致 */}
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: outerOpen ? '1fr' : '0fr', opacity: outerOpen ? 1 : 0 }}
      >
        <div className="flex flex-col gap-2">
          {timelines.map((t) => (
            <TimelineRow key={t} name={t} completed={completed.has(t)} text={slice.snippets?.[t]} isMulti={isMulti} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 单个周目行。
 *   - 单周目(isMulti=false):直接显示文本,无子折叠
 *   - 多周目(isMulti=true):子折叠,各自独立 state,双向动画
 * 内容超 PREVIEW_CHARS 字:展开后先显示前 N 字 + "展开全文"按钮,点全文看全部。
 */
function TimelineRow({
  name, completed, text, isMulti,
}: {
  name:      string;
  completed: boolean;
  text:      string | undefined;
  isMulti:   boolean;
}): React.JSX.Element {
  const [innerOpen, setInnerOpen] = useState(false);
  const [fullText, setFullText]   = useState(false);

  const hasFull   = !!text && text.length > PREVIEW_CHARS;
  const displayText = fullText ? text : (text?.slice(0, PREVIEW_CHARS) ?? '');

  return (
    <div className="flex flex-col gap-1.5">
      {/* 周目名行:多周目可点击子折叠,单周目不可点击 */}
      <button
        type="button"
        disabled={!isMulti || !completed}
        onClick={isMulti && completed ? () => setInnerOpen((v) => !v) : undefined}
        className="flex items-center gap-1.5 text-left w-full hover:opacity-80 disabled:cursor-default disabled:hover:opacity-100"
      >
        {completed
          ? <span className="i-mdi:check shrink-0" style={{ color: 'var(--ema-info)' }} aria-hidden />
          : <span className="i-mdi:dots-horizontal shrink-0" style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden />
        }
        <span style={{ color: completed ? 'var(--ema-text-secondary)' : 'var(--ema-text-tertiary)' }}>{name}</span>
        {isMulti && completed && (
          <span className="ml-auto" style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden>{innerOpen ? '▼' : '▶'}</span>
        )}
      </button>

      {/* 内层:单周目常驻显示(1fr);多周目子折叠按 innerOpen 切。均用 ema-collapsible 动画 */}
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: innerOpen || !isMulti ? '1fr' : '0fr', opacity: innerOpen || !isMulti ? 1 : 0 }}
      >
        {completed && text ? (
          <div className="pl-5 flex flex-col gap-1">
            {/* 文本区:ema-transition-text-expand 双向动画,预览↔全文高度+淡入淡出。
                预览 overflow-hidden 裁切,全文 overflow-y-auto 滚动(超 32rem) */}
            <div
              className={`ema-transition-text-expand ${fullText ? 'overflow-y-auto' : 'overflow-hidden'}`}
              style={{
                maxHeight: fullText ? '32rem' : '8rem',
                opacity:   fullText ? 1 : 0.92,
              }}
            >
              <p className="text-xs whitespace-pre-wrap break-words"
                 style={{ color: 'var(--ema-text-tertiary)' }}>
                {displayText}
              </p>
            </div>
            {hasFull && !fullText && (
              <button
                type="button"
                onClick={() => setFullText(true)}
                className="text-left hover:opacity-80 w-fit"
                style={{ color: 'var(--ema-info)' }}
              >
                …展开全文
              </button>
            )}
            {hasFull && fullText && (
              <button
                type="button"
                onClick={() => setFullText(false)}
                className="text-left hover:opacity-80 w-fit"
                style={{ color: 'var(--ema-info)' }}
              >
                收起全文
              </button>
            )}
          </div>
        ) : completed ? (
          <p className="pl-5 text-xs italic" style={{ color: 'var(--ema-text-tertiary)' }}>
            （检索返回空,可能该周目无相关内容或 bridge 出错）
          </p>
        ) : null}
      </div>
    </div>
  );
}
