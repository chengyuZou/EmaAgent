// 这些工具负责管理需要用户审阅后再应用的持久化 Artifact 草稿。
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { Artifact, ArtifactId } from '@ema-agent/artifact';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { ArtifactEvent } from '@ema-agent/artifact';
import { randomUUID } from 'node:crypto';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

// ── 内存兜底(未注入 ArtifactStore)──────────────────────────────────────────
// 用于测试和未接完整 store 的最小嵌入方。

const memoryStore = new Map<string, Artifact[]>();

function sessionArtifacts(sessionId: string): Artifact[] {
  let list = memoryStore.get(sessionId);
  if (!list) { list = []; memoryStore.set(sessionId, list); }
  return list;
}

// ── ArtifactWrite ─────────────────────────────────────────────────────────────

const writeSchema = z.object({
  id: z.string().optional()
    .describe('Artifact ID to update. Omit to create a new artifact.'),
  type: z.string().min(1)
    .describe(
      'MIME-style type. Common values: "text/markdown", "text/html", "text/plain", ' +
      '"text/csv", "text/x-python", "text/x-typescript", "application/json", ' +
      '"application/vnd.ema.diff", "application/vnd.ema.table", "application/vnd.ema.chart".',
    ),
  title: z.string().min(1)
    .describe('Human-readable title shown in WorkspacePane.'),
  content: z.string()
    .describe('Full artifact content.'),
  meta: z.record(z.unknown()).default({})
    .describe('Optional metadata: { language, filename, description, ... }'),
});

type ArtifactWriteInput = z.infer<typeof writeSchema>;

export const ArtifactWriteTool = buildTool<ArtifactWriteInput, Artifact>({
  id: BuiltinTools.ArtifactWrite.id,
  name: BuiltinTools.ArtifactWrite.name,
  description: `Create or update a named artifact rendered in the WorkspacePane.

Use ArtifactWrite instead of Write when:
- Generating content for the user to review before it lands on disk
- Producing code examples, documents, data, or visualizations
- The user asked to "create", "generate", or "draft" something

Common types:
- text/markdown          - rendered as Markdown
- text/html              - sandboxed iframe
- text/csv               - table view
- text/x-python          - code with syntax highlighting
- application/json       - pretty-printed JSON
- application/vnd.ema.diff   - Monaco DiffEditor
- application/vnd.ema.table  - data table
- application/vnd.ema.chart  - chart visualization

After writing, an artifact_upserted event opens WorkspacePane automatically.`,

  inputSchema: writeSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  permissionMeta: { riskLevel: 'low', accessType: 'write' },

  async execute(input: ArtifactWriteInput, ctx: ToolExecutionContext): Promise<Artifact> {
    // ── 持久存储路径 ──────────────────────────────────────────────────────────
    if (ctx.artifactStore) {
      const artifact = ctx.artifactStore.upsert({
        id:        input.id as ArtifactId | undefined,
        sessionId: asSessionId(ctx.sessionId),
        turnId:    asTurnId(ctx.turnId),
        type:      input.type as Artifact['type'],
        title:     input.title,
        content:   input.content,
        meta:      input.meta,
      });

      ctx.emit?.({ type: 'artifact_upserted', sessionId: asSessionId(ctx.sessionId), artifact } satisfies ArtifactEvent);

      if (ctx.artifactStore.countWarning(asSessionId(ctx.sessionId))) {
        ctx.emit?.({
          type:    'artifact_count_warning',
          sessionId: asSessionId(ctx.sessionId),
          message: 'This session has more than 100 artifacts. Consider deleting unused ones.',
        } satisfies ArtifactEvent);
      }

      return artifact;
    }

    // ── 内存兜底 ────────────────────────────────────────────────────────────
    const now       = Date.now();
    const artifacts = sessionArtifacts(ctx.sessionId);
    const idx       = input.id ? artifacts.findIndex((a) => a.id === input.id) : -1;

    const artifact: Artifact = {
      id:              (input.id ?? randomUUID()) as ArtifactId,
      sessionId:       asSessionId(ctx.sessionId),
      turnId:          asTurnId(ctx.turnId),
      type:            input.type as Artifact['type'],
      title:           input.title,
      content:         input.content,
      contentLocation: 'inline',
      meta:            input.meta,
      createdAt:       idx >= 0 ? artifacts[idx]!.createdAt : now,
      updatedAt:       now,
    };

    if (idx >= 0) {
      artifacts[idx] = artifact;
    } else {
      artifacts.push(artifact);
    }

    ctx.emit?.({ type: 'artifact_upserted', sessionId: asSessionId(ctx.sessionId), artifact } satisfies ArtifactEvent);
    return artifact;
  },
});

// ── ArtifactRead ──────────────────────────────────────────────────────────────

const readSchema = z.object({
  id: z.string().min(1).describe('Artifact ID to read.'),
});

export const ArtifactReadTool = buildTool<z.infer<typeof readSchema>, Artifact>({
  id: BuiltinTools.ArtifactRead.id,
  name: BuiltinTools.ArtifactRead.name,
  description: 'Read the current content of an artifact by ID.',

  inputSchema: readSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionMeta: { riskLevel: 'low', accessType: 'read' },

  async execute(input, ctx): Promise<Artifact> {
    if (ctx.artifactStore) {
      const artifact = ctx.artifactStore.get(input.id as ArtifactId);
      if (!artifact) throw new Error(`Artifact not found: ${input.id}`);
      return artifact;
    }
    const found = sessionArtifacts(ctx.sessionId).find((a) => a.id === input.id);
    if (!found) throw new Error(`Artifact not found: ${input.id}`);
    return found;
  },
});

// ── ArtifactList ──────────────────────────────────────────────────────────────

const listSchema = z.object({
  type: z.string().optional()
    .describe('Filter by type, e.g. "text/markdown". Omit to list all.'),
});

export const ArtifactListTool = buildTool<z.infer<typeof listSchema>, Omit<Artifact, 'content'>[]>({
  id: BuiltinTools.ArtifactList.id,
  name: BuiltinTools.ArtifactList.name,
  description: 'List artifacts in the current session (metadata only, no content). Filter by type optionally.',

  inputSchema: listSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionMeta: { riskLevel: 'low', accessType: 'read' },

  async execute(input, ctx): Promise<Omit<Artifact, 'content'>[]> {
    if (ctx.artifactStore) {
      return ctx.artifactStore.list(asSessionId(ctx.sessionId), { type: input.type });
    }
    const artifacts = sessionArtifacts(ctx.sessionId);
    const filtered  = input.type ? artifacts.filter((a) => a.type === input.type) : [...artifacts];
    // 剥离 content,与存储路径一致
    return filtered.map(({ content: _, ...rest }) => rest);
  },
});
