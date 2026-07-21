// 把工具实现投影为稳定排序、深冻结并带版本身份的模型可见清单。

import { createHash } from 'node:crypto';
import { freezePreparedInput } from './prepared-call.js';
import type {
  BuiltTool,
  ToolManifestEntry,
  ToolManifestSnapshot,
} from './types.js';

export function createToolManifestSnapshot(
  tools: readonly BuiltTool[],
  registryVersion: number,
): ToolManifestSnapshot {
  const entries = [...tools]
    .sort((left, right) => compareCodeUnits(left.name, right.name))
    .map(toManifestEntry);
  const revision = createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: 1,
      registryVersion,
      entries: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        inputJsonSchema: canonicalize(entry.inputJsonSchema),
      })),
    }), 'utf8')
    .digest('hex');

  return Object.freeze({
    registryVersion,
    revision,
    entries: Object.freeze(entries),
  });
}

function toManifestEntry(tool: BuiltTool): ToolManifestEntry {
  const descriptor = tool.descriptor();
  const schema = structuredClone(descriptor.inputJsonSchema);
  return Object.freeze({
    id: tool.id,
    name: descriptor.name,
    description: descriptor.description,
    inputJsonSchema: freezePreparedInput(schema),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    normalized[key] = canonicalize(record[key]);
  }
  return normalized;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
