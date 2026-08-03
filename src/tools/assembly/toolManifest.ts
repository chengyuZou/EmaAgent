// 把工具实现投影为稳定排序、深冻结并带版本身份的模型可见清单。

import { createHash } from 'node:crypto';
import { freezePreparedInput } from '../preparation/preparedToolCall.js';
import type { BuiltTool, ToolManifestEntry } from '../Tool/tool.js';
import type { ToolManifestSnapshot } from '../types.js';

export function createToolManifestSnapshot(
  tools: readonly BuiltTool[],
  registryVersion: number,
): ToolManifestSnapshot {
  return createToolManifestSnapshotFromEntries(
    tools.map(toManifestEntry),
    registryVersion,
  );
}

/** 从既有 Manifest 条目创建能力收窄快照，不重新读取或替换工具实现。 */
export function createToolManifestSnapshotFromEntries(
  sourceEntries: readonly ToolManifestEntry[],
  registryVersion: number,
): ToolManifestSnapshot {
  const entries = [...sourceEntries]
    .sort(compareManifestEntries)
    .map((entry) => Object.freeze({
      id: entry.id,
      name: entry.name,
      origin: freezeOrigin(entry.origin),
      description: entry.description,
      inputJsonSchema: freezePreparedInput(structuredClone(entry.inputJsonSchema)),
    }));
  const revision = createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: 2,
      entries: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        origin: entry.origin,
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

/**
 * Builtin 保持连续稳定前缀，避免 MCP 连接变化把内置工具的 Provider 缓存段打散。
 * Builtin 使用内部稳定 ID；MCP 使用未经清洗的 Server/Tool 身份，展示名只作兜底。
 */
function compareManifestEntries(
  left: ToolManifestEntry,
  right: ToolManifestEntry,
): number {
  if (left.origin.kind !== right.origin.kind) {
    return left.origin.kind === 'builtin' ? -1 : 1;
  }
  if (left.origin.kind === 'builtin' || right.origin.kind === 'builtin') {
    return compareCodeUnits(left.id, right.id)
      || compareCodeUnits(left.name, right.name);
  }
  return compareCodeUnits(left.origin.serverName, right.origin.serverName)
    || compareCodeUnits(left.origin.serverToolName, right.origin.serverToolName)
    || compareCodeUnits(left.name, right.name)
    || compareCodeUnits(left.id, right.id);
}

function toManifestEntry(tool: BuiltTool): ToolManifestEntry {
  const descriptor = tool.descriptor();
  const schema = structuredClone(descriptor.inputJsonSchema);
  return Object.freeze({
    id: tool.id,
    name: descriptor.name,
    origin: freezeOrigin(tool.origin),
    description: descriptor.description,
    inputJsonSchema: freezePreparedInput(schema),
  });
}

function freezeOrigin(origin: ToolManifestEntry['origin']): ToolManifestEntry['origin'] {
  return origin.kind === 'mcp'
    ? Object.freeze({
        kind: 'mcp',
        serverName: origin.serverName,
        serverToolName: origin.serverToolName,
      })
    : Object.freeze({ kind: 'builtin' });
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
