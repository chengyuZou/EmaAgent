// 将模型返回的 JSON 解析成结构化 VisionBlock，支持严格失败与尽力降级两种模式。

import type { VisionBlock, VisionBlockKind } from './types.js';
import { VisionError } from './errors.js';
import type { VisionParseMode } from './types.js';

export interface ParsedVisionPayload {
  text: string;
  markdown?: string;
  blocks: VisionBlock[];
  warnings?: string[];
}

const BLOCK_KINDS = new Set<VisionBlockKind>([
  'text',
  'table',
  'image',
  'layout',
  'formula',
  'caption',
]);

export function parseVisionPayload(
  raw: string,
  options: { mode?: VisionParseMode } = {},
): ParsedVisionPayload {
  const mode = options.mode ?? 'best_effort';
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return handleParseFailure(raw, 'vision/output_parse_failed: no JSON object found', mode);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return handleParseFailure(raw, 'vision/output_parse_failed: invalid JSON', mode);
  }

  if (!isRecord(parsed)) {
    return handleParseFailure(raw, 'vision/output_parse_failed: payload is not an object', mode);
  }

  const text = stringValue(parsed['text']) ?? raw.trim();
  const markdown = stringValue(parsed['markdown']);
  const blocks = Array.isArray(parsed['blocks'])
    ? parsed['blocks']
        .map((value, index) => normalizeBlock(value, index))
        .filter((value): value is VisionBlock => value !== null)
    : [];
  const warnings = normalizeWarnings(parsed['warnings']);

  return {
    text,
    ...(markdown ? { markdown } : {}),
    blocks: blocks.length > 0 ? blocks : [{
      id: 'block-1',
      kind: 'text',
      text,
      ...(markdown ? { markdown } : {}),
    }],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  if (body.startsWith('{') && body.endsWith('}')) return body;

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return null;
}

function fallbackPayload(raw: string, warning: string): ParsedVisionPayload {
  const text = raw.trim();
  return {
    text,
    blocks: text
      ? [{ id: 'block-1', kind: 'text', text }]
      : [],
    warnings: [warning],
  };
}

function handleParseFailure(
  raw: string,
  warning: string,
  mode: VisionParseMode,
): ParsedVisionPayload {
  if (mode === 'strict') {
    throw new VisionError('vision/output_parse_failed', warning, {
      details: { rawTextExcerpt: raw.slice(0, 2000) },
      retryable: true,
    });
  }
  return fallbackPayload(raw, warning);
}

function normalizeBlock(value: unknown, index: number): VisionBlock | null {
  if (!isRecord(value)) return null;

  const text = stringValue(value['text']);
  const markdown = stringValue(value['markdown']);
  if (!text && !markdown) return null;

  const rawKind = stringValue(value['kind']);
  const kind: VisionBlockKind = rawKind && BLOCK_KINDS.has(rawKind as VisionBlockKind)
    ? rawKind as VisionBlockKind
    : 'text';

  const bbox = normalizeBbox(value['bbox']);
  const confidence = numberValue(value['confidence']);
  const id = stringValue(value['id']) ?? `block-${index + 1}`;

  return {
    id,
    kind,
    text: text ?? markdown ?? '',
    ...(markdown ? { markdown } : {}),
    ...(bbox ? { bbox } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function normalizeBbox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const nums = value.map(numberValue);
  if (nums.some((n) => n === undefined)) return undefined;
  return nums as [number, number, number, number];
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(stringValue)
    .filter((item): item is string => item !== undefined && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
