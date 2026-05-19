import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';
import type { Artifact, EmaStreamEvent } from '@ema-agent/contracts';
import { randomUUID } from 'node:crypto';

// ── In-memory artifact store (per session) ────────────────────────────────────
// Real persistence is handled by packages/artifact ArtifactStore.
// This in-memory store is used when the ArtifactStore is not injected into ctx.

const memoryStore = new Map<string, Artifact[]>();

function sessionArtifacts(sessionId: string): Artifact[] {
  let list = memoryStore.get(sessionId);
  if (!list) { list = []; memoryStore.set(sessionId, list); }
  return list;
}

// ── artifact_write ────────────────────────────────────────────────────────────

const writeSchema = z.object({
  id: z
    .string()
    .optional()
    .describe('Artifact ID to update. Omit to create a new artifact.'),
  type: z
    .string()
    .min(1)
    .describe(
      'MIME-style type string, e.g. "text/markdown", "application/json", "text/html", ' +
        '"application/vnd.ema.react", "application/vnd.ema.diff".',
    ),
  title: z.string().min(1).describe('Human-readable title shown in WorkspacePane.'),
  content: z.string().describe('Full artifact content.'),
  meta: z
    .record(z.unknown())
    .default({})
    .describe('Arbitrary metadata (language, filename, etc.).'),
});

type ArtifactWriteInput = z.infer<typeof writeSchema>;

export const artifactWriteTool = buildTool<ArtifactWriteInput, Artifact>({
  name: 'artifact_write',
  description: `Create or update an artifact — a named piece of content rendered in the WorkspacePane.

Common types:
- \`text/markdown\` — rendered as Markdown
- \`text/html\` — rendered in a sandboxed iframe
- \`application/json\` — pretty-printed JSON
- \`application/vnd.ema.react\` — React component (rendered by the JSX sandbox)
- \`application/vnd.ema.diff\` — diff shown in Monaco DiffEditor

After writing, an \`artifact_upserted\` SSE event is emitted so the frontend opens the pane immediately.`,

  inputSchema: writeSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input: ArtifactWriteInput, ctx: ToolExecutionContext): Promise<Artifact> {
    const now = Date.now();
    const artifacts = sessionArtifacts(ctx.sessionId);
    const existingIdx = input.id ? artifacts.findIndex((a) => a.id === input.id) : -1;

    const artifact: Artifact = {
      id: (input.id ?? randomUUID()) as Artifact['id'],
      type: input.type,
      title: input.title,
      content: input.content,
      contentLocation: 'inline',
      meta: input.meta,
      createdAt: existingIdx >= 0 ? artifacts[existingIdx]!.createdAt : now,
      updatedAt: now,
    };

    if (existingIdx >= 0) {
      artifacts[existingIdx] = artifact;
    } else {
      artifacts.push(artifact);
    }

    ctx.emit?.({
      type: 'artifact_upserted',
      artifact,
    } satisfies EmaStreamEvent);

    return artifact;
  },
});

// ── artifact_read ─────────────────────────────────────────────────────────────

const readSchema = z.object({
  id: z.string().min(1).describe('Artifact ID to read.'),
});

export const artifactReadTool = buildTool<z.infer<typeof readSchema>, Artifact>({
  name: 'artifact_read',
  description: `Read the current content of an artifact by ID.`,

  inputSchema: readSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input, ctx): Promise<Artifact> {
    const artifacts = sessionArtifacts(ctx.sessionId);
    const found = artifacts.find((a) => a.id === input.id);
    if (!found) throw new Error(`Artifact not found: ${input.id}`);
    return found;
  },
});

// ── artifact_list ─────────────────────────────────────────────────────────────

const listSchema = z.object({
  type: z
    .string()
    .optional()
    .describe('Filter by artifact type, e.g. "text/markdown". Omit to list all.'),
});

export const artifactListTool = buildTool<z.infer<typeof listSchema>, Artifact[]>({
  name: 'artifact_list',
  description: `List all artifacts in the current session, optionally filtered by type.`,

  inputSchema: listSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input, ctx): Promise<Artifact[]> {
    const artifacts = sessionArtifacts(ctx.sessionId);
    return input.type ? artifacts.filter((a) => a.type === input.type) : [...artifacts];
  },
});
