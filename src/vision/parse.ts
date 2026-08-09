// 将模型文本尽力解析成结构化视觉结果；普通文本本身也是合法的降级结果。
import type { VisionBlock, VisionBlockKind } from './types.js';

interface ParsedVisionResult {
  readonly text: string;
  readonly markdown?: string;
  readonly blocks: readonly VisionBlock[];
}

const BLOCK_KINDS = new Set<VisionBlockKind>([
  'text',
  'table',
  'image',
  'layout',
  'formula',
  'caption',
]);

export function parseVisionResult(raw: string): ParsedVisionResult {
  const text = raw.trim();
  const candidate = extractJsonCandidate(text);
  if (!candidate) return fallbackResult(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return fallbackResult(text);
  }
  if (!isRecord(parsed)) return fallbackResult(text);

  const parsedText = stringValue(parsed['text']) ?? text;
  const markdown = stringValue(parsed['markdown']);
  const blocks = Array.isArray(parsed['blocks'])
    ? parsed['blocks']
        .map(normalizeBlock)
        .filter((block): block is VisionBlock => block !== undefined)
    : [];

  return {
    text: parsedText,
    ...(markdown ? { markdown } : {}),
    blocks: blocks.length > 0
      ? blocks
      : [{
          id: 'block-1',
          kind: 'text',
          text: parsedText,
          ...(markdown ? { markdown } : {}),
        }],
  };
}

function extractJsonCandidate(raw: string): string | undefined {
  if (!raw) return undefined;
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1]?.trim() ?? raw;
  if (body.startsWith('{') && body.endsWith('}')) return body;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : undefined;
}

function fallbackResult(text: string): ParsedVisionResult {
  return {
    text,
    blocks: text ? [{ id: 'block-1', kind: 'text', text }] : [],
  };
}

function normalizeBlock(value: unknown, index: number): VisionBlock | undefined {
  if (!isRecord(value)) return undefined;
  const text = stringValue(value['text']);
  const markdown = stringValue(value['markdown']);
  if (!text && !markdown) return undefined;

  const rawKind = stringValue(value['kind']);
  const kind = rawKind && BLOCK_KINDS.has(rawKind as VisionBlockKind)
    ? rawKind as VisionBlockKind
    : 'text';
  const bbox = normalizeBbox(value['bbox']);
  const confidence = numberValue(value['confidence']);
  return {
    id: stringValue(value['id']) ?? `block-${index + 1}`,
    kind,
    text: text ?? markdown ?? '',
    ...(markdown ? { markdown } : {}),
    ...(bbox ? { bbox } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function normalizeBbox(value: unknown): readonly [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const numbers = value.map(numberValue);
  if (numbers.some((number) => number === undefined)) return undefined;
  return numbers as [number, number, number, number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
