import type { LlmRouter, AssistantBlock } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';
import type {
  ExtractionOutput, ConsolidationOutput, ExtractedNode,
  ExtractedEdge, ExtractedItem,
} from './types.js';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';

// ── Resolving the 'memory' binding ───────────────────────────────────────────

interface ResolvedBinding {
  providerId: string;
  model:      string;
}

function resolveMemoryBinding(
  llm: LlmRouter,
  modelBindings: ModelBindingsRepo,
): ResolvedBinding | null {
  const binding = modelBindings.get('memory');
  if (binding) {
    return { providerId: binding.providerConfigId, model: binding.model };
  }
  // Last-resort: use whatever provider is available with its default model.
  const providerId = llm.firstProviderId();
  if (!providerId) return null;
  const model = llm.defaultModelFor(providerId);
  if (!model) return null;
  return { providerId, model };
}

// ── Generic JSON-only completion ─────────────────────────────────────────────

async function runJsonCompletion(
  llm: LlmRouter,
  binding: ResolvedBinding,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const completion = await llm.complete({
    providerId:  binding.providerId,
    model:       binding.model,
    messages: [
      { role: 'user', content: prompt },
    ],
    maxTokens:   2500,
    temperature: 0.2,
    signal,
  });

  // Collect text from blocks (ignoring thinking blocks)
  const text = completion.blocks
    .filter((b: AssistantBlock): b is AssistantBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text)
    .join('');

  return text;
}

// ── JSON repair / extraction ─────────────────────────────────────────────────

/**
 * Some models wrap JSON in markdown fences or include preamble text despite
 * being told not to. Strip fences and locate the first {...} JSON object.
 */
function extractJson(raw: string): unknown {
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('memory.extract: no JSON object found in LLM output');
  }
  const slice = stripped.slice(start, end + 1);
  return JSON.parse(slice);
}

// ── Extraction call ──────────────────────────────────────────────────────────

const VALID_NODE_TYPES: ReadonlySet<MemoryNodeType> = new Set<MemoryNodeType>([
  'user_fact', 'entity', 'event', 'emotion', 'preference', 'relationship',
]);
const VALID_ITEM_KINDS: ReadonlySet<MemoryItemKind> = new Set<MemoryItemKind>([
  'user', 'feedback', 'project', 'reference',
]);

function sanitizeExtraction(raw: unknown): ExtractionOutput {
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
      new_nodes.push({
        label,
        nodeType:    type as MemoryNodeType,
        description: desc,
        importance:  clamp(asNumber(entry['importance']) ?? 50, 0, 100),
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
      new_edges.push({ fromLabel: f, toLabel: t, relation: r });
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
      memory_items.push({
        kind:       kind as MemoryItemKind,
        title,
        body,
        importance: clamp(asNumber(entry['importance']) ?? 50, 0, 100),
      });
    }
  }

  const delta = typeof obj['session_note_delta'] === 'string' ? obj['session_note_delta'] : '';

  return { new_nodes, new_edges, memory_items, session_note_delta: delta };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runExtraction(
  llm:           LlmRouter,
  modelBindings: ModelBindingsRepo,
  prompt:        string,
  signal?:       AbortSignal,
): Promise<ExtractionOutput | null> {
  const binding = resolveMemoryBinding(llm, modelBindings);
  if (!binding) return null;
  const text = await runJsonCompletion(llm, binding, prompt, signal);
  return sanitizeExtraction(extractJson(text));
}

export async function runConsolidation(
  llm:           LlmRouter,
  modelBindings: ModelBindingsRepo,
  prompt:        string,
  signal?:       AbortSignal,
): Promise<ConsolidationOutput | null> {
  const binding = resolveMemoryBinding(llm, modelBindings);
  if (!binding) return null;
  const text = await runJsonCompletion(llm, binding, prompt, signal);
  const parsed = extractJson(text) as Record<string, unknown>;
  const updated = typeof parsed['updated_description'] === 'string'
    ? parsed['updated_description']
    : '';
  if (!updated.trim()) return null;
  return {
    updated_description: updated.trim(),
    importance_delta:    clamp(asNumber(parsed['importance_delta']) ?? 0, -20, 20),
  };
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
