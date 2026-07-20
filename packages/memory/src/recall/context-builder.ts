import type { Message as ModelMessage } from '@ema-agent/llm';
import { estimateTextTokens } from '@ema-agent/token';
import type { RecallBundle, GraphRecallResult, EpisodicRecallResult, PlanContext } from '../types.js';

export function buildContextMessage(bundle: RecallBundle): ModelMessage | null {
  const parts: string[] = [];

  const fmtDate = (ms: number) =>
    new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

  if (bundle.layer0 && bundle.layer0.nodes.length > 0) {
    const nodes = bundle.layer0.nodes
      .map(n => `- (${n.nodeType}) ${n.label}: ${n.description}`)
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
        const ts = i.updatedAt ? ` (${fmtDate(i.updatedAt)})` : '';
        blob.push(`- [${i.kind}]${ts} ${i.title}: ${i.body}`);
      }
    }
    if (bundle.layer2.otherModes.length > 0) {
      blob.push('\n其他模式相关:');
      for (const i of bundle.layer2.otherModes) {
        const ts = i.updatedAt ? ` (${fmtDate(i.updatedAt)})` : '';
        blob.push(`- [${i.kind}]${ts} ${i.title}: ${i.body}`);
      }
    }
    if (blob.length > 0) parts.push(`## 相关的过往\n${blob.join('\n')}`);
  }

  if (parts.length === 0) return null;

  return {
    role:    'user',
    content: `<memory>\n${parts.join('\n\n')}\n</memory>`,
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
    mode: ctx.mode,
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
