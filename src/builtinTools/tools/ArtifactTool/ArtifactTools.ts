// 管理需要用户审阅后再应用的持久化 Artifact 草稿。
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionEvent } from '@ema-agent/tools';
import type { Artifact, ArtifactId, IArtifactStore } from '@ema-agent/artifact';
import type { ArtifactEvent } from '@ema-agent/artifact';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';

/** Artifact 工具族的窄 Context：持久存储 + 可选事件输出 + 调用身份。 */
interface ArtifactToolContext {
  artifactStore: IArtifactStore;
  emit?: (event: ToolExecutionEvent) => void;
  sessionId: SessionId;
  turnId: TurnId;
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

export const ArtifactWriteTool = buildTool<ArtifactWriteInput, Artifact, BuiltinToolContext, ArtifactToolContext>({
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

  requires: ['artifactStore'],

  validateContext(ctx) {
    if (!ctx.artifactStore) {
      return contextFail('Artifact 能力未装配。');
    }
    return contextOk({
      artifactStore: ctx.artifactStore,
      ...(ctx.emit ? { emit: ctx.emit } : {}),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    });
  },

  async execute(
    input: ArtifactWriteInput,
    context: ArtifactToolContext,
  ): Promise<Artifact> {
    const artifact = context.artifactStore.upsert({
      id:        input.id as ArtifactId | undefined,
      sessionId: asSessionId(context.sessionId),
      turnId:    asTurnId(context.turnId),
      type:      input.type as Artifact['type'],
      title:     input.title,
      content:   input.content,
      meta:      input.meta,
    });

    context.emit?.({ type: 'artifact_upserted', sessionId: context.sessionId, artifact } satisfies ArtifactEvent);

    if (context.artifactStore.countWarning(context.sessionId)) {
      context.emit?.({
        type:    'artifact_count_warning',
        sessionId: asSessionId(context.sessionId),
        message: 'This session has more than 100 artifacts. Consider deleting unused ones.',
      } satisfies ArtifactEvent);
    }

    return artifact;
  },
});

// ── ArtifactRead ──────────────────────────────────────────────────────────────

const readSchema = z.object({
  id: z.string().min(1).describe('Artifact ID to read.'),
});

export const ArtifactReadTool = buildTool<z.infer<typeof readSchema>, Artifact, BuiltinToolContext, ArtifactToolContext>({
  id: BuiltinTools.ArtifactRead.id,
  name: BuiltinTools.ArtifactRead.name,
  description: 'Read the current content of an artifact by ID.',

  inputSchema: readSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionMeta: { riskLevel: 'low', accessType: 'read' },

  requires: ['artifactStore'],

  validateContext(ctx) {
    if (!ctx.artifactStore) {
      return contextFail('Artifact 能力未装配。');
    }
    return contextOk({
      artifactStore: ctx.artifactStore,
      ...(ctx.emit ? { emit: ctx.emit } : {}),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    });
  },

  async execute(input, context): Promise<Artifact> {
    const artifact = context.artifactStore.get(input.id as ArtifactId);
    if (!artifact) throw new Error(`Artifact not found: ${input.id}`);
    return artifact;
  },
});

// ── ArtifactList ──────────────────────────────────────────────────────────────

const listSchema = z.object({
  type: z.string().optional()
    .describe('Filter by type, e.g. "text/markdown". Omit to list all.'),
});

export const ArtifactListTool = buildTool<z.infer<typeof listSchema>, Omit<Artifact, 'content'>[], BuiltinToolContext, ArtifactToolContext>({
  id: BuiltinTools.ArtifactList.id,
  name: BuiltinTools.ArtifactList.name,
  description: 'List artifacts in the current session (metadata only, no content). Filter by type optionally.',

  inputSchema: listSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionMeta: { riskLevel: 'low', accessType: 'read' },

  requires: ['artifactStore'],

  validateContext(ctx) {
    if (!ctx.artifactStore) {
      return contextFail('Artifact 能力未装配。');
    }
    return contextOk({
      artifactStore: ctx.artifactStore,
      ...(ctx.emit ? { emit: ctx.emit } : {}),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    });
  },

  async execute(input, context): Promise<Omit<Artifact, 'content'>[]> {
    return context.artifactStore.list(context.sessionId, { type: input.type });
  },
});
