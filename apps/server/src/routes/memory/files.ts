// 记忆文件浏览与用户编辑：目录列表、内容读取与搜索只读；content 写入（正式记忆编辑）
// 与 notes 创建（待整合便签）是仅有的两个写口，整合占用锁在此层判定。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MemoryFileChangedError,
  MemoryFileNotEditableError,
  MemoryNoteAlreadyExistsError,
  MemoryNoteCharacterRequiredError,
  MemoryNoteEmptyError,
  createMemoryNote,
  listMemoryFiles,
  readMemoryFile,
  searchMemoryFiles,
  writeMemoryFile,
  type MemoryNoteTarget,
} from '@ema-agent/memory';
import type { MemoryJobsRepo } from '@ema-agent/storage';
import { jsonBody, queryValidator } from '../validate.js';

export interface MemoryFilesRouteDeps {
  readonly memoryRoot: string;
  /** 整合 Job 占用路径是编辑锁的唯一事实源（running 即锁）。 */
  readonly jobs: Pick<MemoryJobsRepo, 'listBusyPaths'>;
}

const listQuery = z.object({
  path: z.string().max(512).optional(),
  cursor: z.string().max(64).optional(),
  maxResults: z.coerce.number().int().min(1).max(2_000).optional(),
});

const readQuery = z.object({
  path: z.string().min(1).max(512),
  lineOffset: z.coerce.number().int().min(1).optional(),
  maxLines: z.coerce.number().int().min(1).max(10_000).optional(),
});

const searchBody = z.object({
  queries: z.array(z.string().min(1).max(200)).min(1).max(8),
  matchMode: z.enum(['any', 'all_on_same_line', 'all_within_lines']).optional(),
  path: z.string().max(512).optional(),
  cursor: z.string().max(64).optional(),
  contextLines: z.number().int().min(0).max(20).optional(),
  caseSensitive: z.boolean().optional(),
  normalized: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(200).optional(),
});

const writeBody = z.object({
  path: z.string().min(1).max(512),
  content: z.string(),
  baseMtimeMs: z.number().optional(),
});

const noteBody = z.object({
  target: z.enum(['work', 'relationshipShared', 'relationshipCharacter']),
  /** relationshipCharacter 必填；其余轨忽略。 */
  characterDirectoryName: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

export const memoryFilesRoute = (deps: MemoryFilesRouteDeps) =>
  new Hono()
    .get('/files', queryValidator(listQuery), async context => {
      return context.json(await listMemoryFiles(deps.memoryRoot, context.req.valid('query')));
    })
    .get('/files/content', queryValidator(readQuery), async context => {
      const result = await readMemoryFile(deps.memoryRoot, context.req.valid('query'));
      if (!result) return context.json({ error: 'file_not_found' }, 404);
      return context.json(result);
    })
    .post('/files/search', jsonBody(searchBody), async context => {
      return context.json(await searchMemoryFiles(deps.memoryRoot, context.req.valid('json')));
    })
    // 用户编辑正式记忆：先查整合锁，再按 mtime 防双向盲盖；白名单由 memory 包拥有。
    .put('/files/content', jsonBody(writeBody), async context => {
      const { path, content, baseMtimeMs } = context.req.valid('json');
      const locked = deps.jobs.listBusyPaths().some(entry => entry.relativePath === path);
      if (locked) {
        return context.json({ error: 'memory_file_locked', message: '记忆整合正在进行，此文件暂时不可编辑' }, 409);
      }
      try {
        return context.json(await writeMemoryFile(deps.memoryRoot, { path, content, baseMtimeMs }));
      } catch (error) {
        if (error instanceof MemoryFileNotEditableError) {
          return context.json({ error: 'memory_file_not_editable', message: error.message }, 403);
        }
        if (error instanceof MemoryFileChangedError) {
          return context.json({ error: 'memory_file_changed', message: error.message }, 409);
        }
        throw error;
      }
    })
    // 记一条：写入对应轨的 extensions/notes/，下轮整合消化。
    .post('/files/notes', jsonBody(noteBody), async context => {
      const { target, characterDirectoryName, title, content } = context.req.valid('json');
      const noteTarget: MemoryNoteTarget = target === 'relationshipCharacter'
        ? { kind: 'relationshipCharacter', characterDirectoryName: characterDirectoryName ?? '' }
        : { kind: target };
      try {
        const filePath = await createMemoryNote(noteTarget, title, content);
        return context.json({ path: filePath }, 201);
      } catch (error) {
        if (error instanceof MemoryNoteEmptyError) {
          return context.json({ error: 'invalid_request', message: '便签内容不能为空' }, 400);
        }
        if (error instanceof MemoryNoteCharacterRequiredError) {
          return context.json({ error: 'invalid_request', message: '角色便签缺少角色目录名' }, 400);
        }
        if (error instanceof MemoryNoteAlreadyExistsError) {
          return context.json({ error: 'memory_note_exists', message: error.message }, 409);
        }
        throw error;
      }
    });