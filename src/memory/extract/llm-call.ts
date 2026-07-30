import type { LanguageModel } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';
import type {
  ExtractionOutput, ExtractedNode,
  ExtractedEdge, ExtractedItem,
} from './types.js';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';
import { runMemoryJsonCompletion } from '../modelJsonCompletion.js';

// ── Extraction call ──────────────────────────────────────────────────────────

const VALID_NODE_TYPES: ReadonlySet<MemoryNodeType> = new Set<MemoryNodeType>([
  'user_fact', 'entity', 'event', 'emotion', 'preference', 'relationship',
]);
const VALID_ITEM_KINDS: ReadonlySet<MemoryItemKind> = new Set<MemoryItemKind>([
  'user', 'feedback', 'project', 'reference',
]);

/** 证据引用的最小长度：防止用"的"、"好"这类无信息量片段蒙混。 */
const MIN_EVIDENCE_QUOTE_CHARS = 8;

/**
 * 校验证据引用真实存在于源文本。两边都归一化空白后做子串匹配——
 * 引用必须逐字来自对话原文，这是提取侧唯一的幻觉防线。
 */
function hasValidEvidenceQuote(quote: unknown, sourceText: string): quote is string {
  if (typeof quote !== 'string') return false;
  const normalizedQuote = quote.trim().replace(/\s+/g, ' ');
  if (normalizedQuote.length < MIN_EVIDENCE_QUOTE_CHARS) return false;
  const normalizedSource = sourceText.replace(/\s+/g, ' ');
  return normalizedSource.includes(normalizedQuote);
}

function sanitizeExtraction(raw: unknown, sourceText: string): ExtractionOutput {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const new_nodes: ExtractedNode[] = [];
  if (Array.isArray(obj['new_nodes'])) {
    for (const n of obj['new_nodes']) {
      if (!n || typeof n !== 'object') continue;
      const entry = n as Record<string, unknown>;
      const label = typeof entry['label'] === 'string' ? entry['label'].trim() : '';
      const type  = entry['node_type'];
      const desc  = typeof entry['description'] === 'string' ? entry['description'].trim() : '';
      if (!label || !desc) continue;
      if (typeof type !== 'string' || !VALID_NODE_TYPES.has(type as MemoryNodeType)) continue;
      if (!hasValidEvidenceQuote(entry['evidence_quote'], sourceText)) continue;
      new_nodes.push({
        label,
        nodeType:    type as MemoryNodeType,
        description: desc,
        importance:  clamp(asNumber(entry['importance']) ?? 50, 0, 100),
        evidenceQuote: (entry['evidence_quote'] as string).trim(),
      });
    }
  }

  const new_edges: ExtractedEdge[] = [];
  if (Array.isArray(obj['new_edges'])) {
    for (const e of obj['new_edges']) {
      if (!e || typeof e !== 'object') continue;
      const entry = e as Record<string, unknown>;
      const f = typeof entry['from_label'] === 'string' ? entry['from_label'].trim() : '';
      const t = typeof entry['to_label']   === 'string' ? entry['to_label'].trim()   : '';
      const r = typeof entry['relation']   === 'string' ? entry['relation'].trim()   : '';
      if (!f || !t || !r) continue;
      // 端点 type 可选: 非法值按缺失处理, 走 label 唯一兜底, 不因此丢边。
      const ft = typeof entry['from_type'] === 'string' && VALID_NODE_TYPES.has(entry['from_type'] as MemoryNodeType)
        ? entry['from_type'] as MemoryNodeType
        : undefined;
      const tt = typeof entry['to_type'] === 'string' && VALID_NODE_TYPES.has(entry['to_type'] as MemoryNodeType)
        ? entry['to_type'] as MemoryNodeType
        : undefined;
      new_edges.push({
        fromLabel: f,
        toLabel:   t,
        relation:  r,
        ...(ft ? { fromType: ft } : {}),
        ...(tt ? { toType: tt } : {}),
      });
    }
  }

  const memory_items: ExtractedItem[] = [];
  if (Array.isArray(obj['memory_items'])) {
    for (const i of obj['memory_items']) {
      if (!i || typeof i !== 'object') continue;
      const entry = i as Record<string, unknown>;
      const kind  = entry['kind'];
      const title = typeof entry['title'] === 'string' ? entry['title'].trim() : '';
      const body  = typeof entry['body']  === 'string' ? entry['body'].trim()  : '';
      if (!title || !body) continue;
      if (typeof kind !== 'string' || !VALID_ITEM_KINDS.has(kind as MemoryItemKind)) continue;
      if (!hasValidEvidenceQuote(entry['evidence_quote'], sourceText)) continue;
      memory_items.push({
        kind:       kind as MemoryItemKind,
        title,
        body,
        importance: clamp(asNumber(entry['importance']) ?? 50, 0, 100),
        evidenceQuote: (entry['evidence_quote'] as string).trim(),
      });
    }
  }

  const delta = typeof obj['session_note_delta'] === 'string' ? obj['session_note_delta'] : '';

  return { new_nodes, new_edges, memory_items, session_note_delta: delta };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runExtraction(
  llm:           LanguageModel,
  modelBindings: ModelBindingsRepo,
  prompt:        string,
  signal:        AbortSignal | undefined,
  sourceText:    string,
): Promise<ExtractionOutput | null> {
  const parsed = await runMemoryJsonCompletion(llm, modelBindings, prompt, signal);
  return parsed === null ? null : sanitizeExtraction(parsed, sourceText);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
