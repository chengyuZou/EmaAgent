// 调用当前模型生成旧对话摘要，不负责持久化或最终上下文预算判定。
import type { AssistantBlock, LanguageModel, Message as ModelMessage, UserBlock } from '@ema-agent/llm';
import type { TurnMode } from '@ema-agent/contracts';
import { buildCompactionPrompt } from './compactionPrompts.js';
import { estimateMessagesTokens } from '@ema-agent/token';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TRUNCATE_FRACTION = 0.2;   // 每次重试丢弃最旧的 20%
const MIN_PRESERVE_MESSAGES = 4; // 压缩后尾部至少保留这么多条消息

/** 触发压缩的上下文窗口占比(消息 > 85% 触发压缩)。 */
const COMPACTION_TRIGGER_RATIO = 0.85;
/** 为压缩摘要输出预留的上下文窗口占比。 */
const COMPACTION_OUTPUT_RATIO  = 0.20;
/** 压缩 LLM 调用的最小输出 token 数(小模型下限)。 */
const MIN_COMPACTION_OUTPUT    = 2000;

// ── 切片格式化(供 LLM 输入) ─────────────────────────────────────

function formatHistory(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;        // 永不把 system 喂回给摘要器
    if (typeof msg.content === 'string') {
      lines.push(`[${msg.role}]\n${msg.content}\n`);
      continue;
    }
    const parts: string[] = [];
    for (const blk of msg.content) {
      parts.push(formatBlock(blk));
    }
    lines.push(`[${msg.role}]\n${parts.join('\n')}\n`);
  }
  return lines.join('\n');
}

// TODO thinking块这里也可以加上去
function formatBlock(blk: UserBlock | AssistantBlock): string {
  const tag = (blk as { type?: string }).type;
  switch (tag) {
    case 'text':         return (blk as { text: string }).text;
    case 'thinking':     return '';
    case 'tool_use': {
      const t = blk as { name: string; args: unknown };
      return `<tool_use name="${t.name}">${JSON.stringify(t.args)}</tool_use>`;
    }
    case 'tool_result': {
      const t = blk as { content: string | unknown[]; isError?: boolean };
      const body = typeof t.content === 'string' ? t.content : '[non-text result]';
      return `<tool_result${t.isError ? ' error="true"' : ''}>${body}</tool_result>`;
    }
    case 'image_url':
    case 'image_data':
    case 'audio_data':
    case 'file_url':
    case 'file_data':    return `[${tag}]`;
    default:             return '';
  }
}

// ── 图片剥离(保留顺序,用占位文本替换) ──────────

const MEDIA_TYPES = new Set(['image_url', 'image_data', 'audio_data', 'file_url', 'file_data']);

function stripImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const next: UserBlock[] = msg.content.map((blk) => {
      const t = (blk as { type?: string }).type;
      if (t && MEDIA_TYPES.has(t)) return { type: 'text', text: `[${t}]` };
      // 同时剥离嵌套在 tool_result content 数组里的媒体
      if (t === 'tool_result') {
        const tr = blk as { type: 'tool_result'; toolUseId: string; content: string | unknown[]; isError?: boolean };
        if (Array.isArray(tr.content)) {
          const stripped = tr.content.map((part) => {
            const pt = (part as { type?: string }).type;
            return (pt && MEDIA_TYPES.has(pt))
              ? { type: 'text' as const, text: `[${pt}]` }
              : part;
          });
          return { type: 'tool_result', toolUseId: tr.toolUseId, content: stripped, isError: tr.isError ?? false } as UserBlock;
        }
      }
      return blk;
    });
    return { role: 'user', content: next };
  });
}

// ── Macro 压缩核心 ─────────────────────────────────────────────────────

export interface MacroCompactArgs {
  llm:           LanguageModel;
  /** 当前 Turn 的 provider - 压缩用用户选的同一个模型。 */
  providerId:    string;
  /** 当前 Turn 的模型。 */
  model:         string;
  mode:          TurnMode;
  /** 待摘要的消息(较旧的部分)。 */
  toCompact:     ModelMessage[];
  /**
   * 必须落在这个 token 上限以下。若历史切片超出该窗口,
   * 摘要前先截断最旧消息以适配(与 Claude Code 一致 - 按当前模型容量截断)。
   */
  modelContextWindow: number;
  signal?:       AbortSignal;
}

export interface MacroCompactResult {
  /** 压缩后的摘要文本。空串表示压缩无操作或重试耗尽。 */
  summary:           string;
  /** 最终尝试是否成功 - false 表示调用方应放弃压缩。 */
  succeeded:         boolean;
   /** 诊断 - 已尝试次数。 */
  attempts:          number;
}

/**
 * 执行 macro 压缩:格式化切片、调 LLM、上下文溢出后重试。
 * 调用方在持久化摘要前会校验最终上下文预算。
 */
export async function runMacroCompaction(
  args: MacroCompactArgs,
): Promise<MacroCompactResult> {
  if (args.toCompact.length === 0) {
    return { summary: '', succeeded: false, attempts: 0 };
  }
  // 压缩始终用当前 Turn 的模型 - 即用户在前端选择器里选的
  // (providerId, model)。无需单独绑定。若历史超过该模型上下文窗口,
  // 下面的截断循环每次重试丢弃最旧的 20%,直到塞得下。

  const { providerId, model } = args;

  let toCompact = stripImages(args.toCompact);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const history = formatHistory(toCompact);
    const prompt  = buildCompactionPrompt({ mode: args.mode, history });

    // 发请求前的 token 预估。若 prompt 超过模型上下文窗口的 85%,
    // 截断后重试,而不是明知超限还发出去。
    //
    // 策略:
    //   第 1 次 - 比例裁剪:保留 (阈值/预估) 比例的消息,一步落到阈值
    //             以下。处理大模型切换(如 1M -> 200K)不必烧多次重试。
    //   第 2+ 次 - 每次 20% 小幅裁剪,修正 token 预估的误差。
    //   已达 MIN_PRESERVE_MESSAGES 仍超限 -> 立即放弃,不调 LLM
    //             (避免必定的 PTL 错误)。
    const estimated = estimateMessagesTokens([{ role: 'user', content: prompt }]);
    const threshold = Math.floor(args.modelContextWindow * COMPACTION_TRIGGER_RATIO);
    if (estimated > threshold) {
      if (toCompact.length <= MIN_PRESERVE_MESSAGES) {
        return { summary: '', succeeded: false, attempts: attempt };
      }
      if (attempt === 1) {
        const keepFraction = threshold / estimated;
        const keepCount    = Math.max(MIN_PRESERVE_MESSAGES, Math.floor(toCompact.length * keepFraction));
        toCompact = toCompact.slice(toCompact.length - keepCount);
      } else {
        toCompact = truncateOldest(toCompact, TRUNCATE_FRACTION);
      }
      continue;
    }

    try {
      const remainingOutputTokens = Math.max(1, args.modelContextWindow - estimated);
      const desiredOutputTokens = Math.max(
        MIN_COMPACTION_OUTPUT,
        Math.floor(args.modelContextWindow * COMPACTION_OUTPUT_RATIO),
      );
      const completion = await args.llm.complete({
        providerId,
        model,
        messages:    [{ role: 'user', content: prompt }],
        maxTokens:   Math.min(desiredOutputTokens, remainingOutputTokens),
        temperature: 0.2,
        signal:      args.signal,
      });

      const summary = collectText(completion.blocks).trim();
      if (!summary) {
        return {
          summary: '',
          succeeded: false, attempts: attempt,
        };
      }

      return { summary, succeeded: true, attempts: attempt };

    } catch (err) {
      const reason = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isPTL = reason.includes('prompt') && (reason.includes('too long') || reason.includes('size'));
      const isOverflow = reason.includes('context') && reason.includes('length');
      const retryable = isPTL || isOverflow;
      if (!retryable || toCompact.length <= MIN_PRESERVE_MESSAGES) {
        return { summary: '', succeeded: false, attempts: attempt };
      }
      toCompact = truncateOldest(toCompact, TRUNCATE_FRACTION);
    }
  }

  return { summary: '', succeeded: false, attempts: MAX_RETRIES };
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function truncateOldest(messages: ModelMessage[], fraction: number): ModelMessage[] {
  const drop = Math.max(1, Math.floor(messages.length * fraction));
  return messages.slice(drop);
}

function collectText(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is AssistantBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text)
    .join('');
}
