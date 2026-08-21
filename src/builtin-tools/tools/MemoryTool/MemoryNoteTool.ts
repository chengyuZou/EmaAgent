// 创建待整合记忆便签（work/relationshipShared/relationshipCharacter）。
// 模型不提供角色目录名；relationshipCharacter 由根 Turn 注入的 memoryNote 闭包
// 绑定本 Turn 已冻结的 characterDirectoryName。
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import type {
  AddMemoryNote,
  MemoryNoteTargetKind,
} from '@ema-agent/memory';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { MEMORY_NOTE_DESCRIPTION } from './prompt.js';

/** MemoryNote 工具的窄 Context：只取便签写入端口；取消与调用身份走 ToolInvocation。 */
interface MemoryNoteToolContext {
  readonly memoryNote: AddMemoryNote;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  target: z
    .enum(['work', 'relationshipShared', 'relationshipCharacter'])
    .describe('Where the note belongs: work - work memory; relationshipShared - shared relationship memory; relationshipCharacter - the current character (bound by the current turn).'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Note title (used to derive the file name).'),
  content: z
    .string()
    .min(1)
    .describe('Content to remember.'),
}).strict();

type MemoryNoteInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface MemoryNoteToolResult {
  /** 新建便签的相对路径。 */
  readonly path: string;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const MemoryNoteTool = buildTool<
  MemoryNoteInput,
  MemoryNoteToolResult,
  MemoryNoteToolContext
>({
  id: BuiltinTools.MemoryNote.id,
  name: BuiltinTools.MemoryNote.name,
  description: MEMORY_NOTE_DESCRIPTION,

  inputSchema,
  isReadOnly: () => false,
  // 持久写入：串行执行，避免并发创建冲突。
  isConcurrencySafe: () => false,
  getToolUseSummary: (input) => `写入记忆便签(${input.target}): ${input.title}`,
  // 创建便签有副作用，交给中央规则与模式收口（默认询问）。
  checkPermissions: async () => ({ behavior: 'passthrough', message: '写入记忆便签需要用户确认' }),

  validateContext(ctx) {
    if (!ctx.memoryNote) {
      return contextFail('当前未装配记忆便签能力。');
    }
    return contextOk({ memoryNote: ctx.memoryNote });
  },

  async execute(
    input: MemoryNoteInput,
    context: MemoryNoteToolContext,
    invocation: ToolInvocation,
  ): Promise<MemoryNoteToolResult> {
    const target: MemoryNoteTargetKind = input.target;
    const path = await context.memoryNote({
      target,
      title: input.title,
      content: input.content,
      signal: invocation.signal,
    });
    return { path };
  },

  // 模型只需要落盘确认与路径；写入详情留给 TOutput 给 UI 与审计。
  mapResultToModelContent(output) {
    return `已写入记忆便签: ${output.path}`;
  },
});
