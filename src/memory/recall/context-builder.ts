import type { Message as ModelMessage } from '@ema-agent/llm';
import type { ContextContribution } from '@ema-agent/context';
import { estimateTextTokens } from '@ema-agent/token';
import type { RecallBundle, GraphRecallResult, EpisodicRecallResult, PlanContext } from '../types.js';

/** 单条记忆正文上限：节点 description 与事件 body 超出后截断，防止超长单条挤占召回预算。 */
const MEMORY_ENTRY_MAX_CHARS = 500;

/** 召回内容的时间与健康提示：记忆是某时刻的印象，不是实时状态。 */
const MEMORY_FRESHNESS_NOTE =
  '以上是从过往对话中记住的内容，可能已过时；涉及文件路径、代码位置或当前状态的说法，使用前请先验证。';

/** 模型不擅长日期算术，直接给"几天前"而不是 ISO 时间戳（Claude memdir 同款经验）。 */
function memoryAge(ms: number, now: number): string {
  const days = Math.max(0, Math.floor((now - ms) / 86_400_000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function clipEntry(text: string): string {
  if (text.length <= MEMORY_ENTRY_MAX_CHARS) return text;
  return `${text.slice(0, MEMORY_ENTRY_MAX_CHARS)}…`;
}

export function buildContextMessage(bundle: RecallBundle): ModelMessage | null {
  const parts: string[] = [];
  const now = Date.now();

  if (bundle.layer0 && bundle.layer0.nodes.length > 0) {
    const nodes = bundle.layer0.nodes
      .map(n => `- (${n.nodeType}) ${n.label}: ${clipEntry(n.description)}`)
      .join('\n');
    const idToLabel = new Map(bundle.layer0.nodes.map(n => [n.id, n.label]));
    const labelOf   = (id: string) => idToLabel.get(id) ?? '[unknown]';
    const edges = bundle.layer0.edges.length === 0 ? '' :
      '\n\n关系:\n' + bundle.layer0.edges
        .map(e => `- ${labelOf(e.from)} —${e.relation}→ ${labelOf(e.to)}`)
        .join('\n');
    parts.push(`## 我对你的了解\n${nodes}${edges}`);
  }

  if (bundle.layer1) {
    parts.push(`## 当前会话摘要\n${bundle.layer1}`);
  }

  if (bundle.layer2) {
    const blob: string[] = [];
    if (bundle.layer2.currentMode.length > 0) {
      blob.push('当前模式相关:');
      for (const i of bundle.layer2.currentMode) {
        const ts = i.updatedAt ? ` (${memoryAge(i.updatedAt, now)})` : '';
        blob.push(`- [${i.kind}]${ts} ${i.title}: ${clipEntry(i.body)}`);
      }
    }
    if (bundle.layer2.otherModes.length > 0) {
      blob.push('\n其他模式相关:');
      for (const i of bundle.layer2.otherModes) {
        const ts = i.updatedAt ? ` (${memoryAge(i.updatedAt, now)})` : '';
        blob.push(`- [${i.kind}]${ts} ${i.title}: ${clipEntry(i.body)}`);
      }
    }
    if (blob.length > 0) parts.push(`## 相关的过往\n${blob.join('\n')}`);
  }

  if (parts.length === 0) return null;

  return {
    role:    'user',
    content: `<memory>\n${parts.join('\n\n')}\n\n${MEMORY_FRESHNESS_NOTE}\n</memory>`,
  };
}

/** Memory 只声明本轮召回数据及其位置，不接收或改写完整模型消息数组。 */
export function buildMemoryContextContribution(
  bundle: RecallBundle,
): ContextContribution | null {
  const message = buildContextMessage(bundle);
  if (!message) return null;

  return {
    id: 'memory.recall',
    source: 'memory',
    placement: 'beforeCurrentTurn',
    message,
  };
}

export function emitRecallLayer(
  ctx: PlanContext,
  layer: 'layer0' | 'layer1' | 'layer2',
  report: {
    status: 'succeeded' | 'skipped' | 'failed';
    itemCount: number;
    tokenEstimate: number;
    durationMs: number;
    error?: string;
    skippedReason?: string;
  },
): void {
  ctx.emit?.({
    type: 'memory_recall_evidence',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    executionProfile: ctx.executionProfile,
    layer,
    report,
  });
}

export function estimateGraphRecallTokens(result: NonNullable<RecallBundle['layer0']>): number {
  const nodes = result.nodes
    .map((n) => `${n.nodeType} ${n.label}: ${n.description}`)
    .join('\n');
  const edges = result.edges
    .map((e) => `${e.from} ${e.relation} ${e.to}`)
    .join('\n');
  return estimateTextTokens([nodes, edges].filter(Boolean).join('\n'));
}

export function countEpisodicItems(result: NonNullable<RecallBundle['layer2']>): number {
  return result.currentMode.length + result.otherModes.length;
}

export function estimateEpisodicRecallTokens(result: NonNullable<RecallBundle['layer2']>): number {
  const items = [...result.currentMode, ...result.otherModes]
    .map((i) => `${i.kind} ${i.title}: ${i.body}`)
    .join('\n');
  return estimateTextTokens(items);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Suppress unused-import warnings — these are re-exported for use in planner
export type { GraphRecallResult, EpisodicRecallResult };
