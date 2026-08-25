// 角色三类资源（Live2D/立绘/参考音频）的管理与文件服务。
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface CharacterResourcesRouteDeps {
  readonly characters: Pick<
    CharacterStore,
    | 'setPrimaryLive2dModel' | 'updateLive2dModel' | 'importLive2dModel' | 'exportLive2dModel'
    | 'deleteLive2dModel' | 'resolveLive2dModelDirectory' | 'resolveLive2dModelFile'
    | 'setPrimaryIllustration' | 'updateIllustration' | 'importIllustration' | 'exportIllustration'
    | 'deleteIllustration' | 'resolveIllustrationFile'
    | 'setPrimaryVoiceSample' | 'updateVoiceSample' | 'importVoiceSample' | 'publishVoiceSample'
    | 'exportVoiceSample' | 'deleteVoiceSample' | 'resolveVoiceSampleFile'
  >;
}

const resourcePatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  stageScale: z.number().min(0.1).max(5).optional(),
  stageOffsetX: z.number().min(-1).max(1).optional(),
  stageOffsetY: z.number().min(-1).max(1).optional(),
  enabled: z.boolean().optional(),
});

const importLive2dBody = z.object({
  sourceZipFile: z.string().min(1),
  isPrimary: z.boolean().optional(),
});

const importFileBody = z.object({
  sourceFile: z.string().min(1),
  isPrimary: z.boolean().optional(),
});

const importVoiceBody = importFileBody.extend({
  promptText: z.string().min(1).max(4_000),
  promptLang: z.string().min(1).max(32),
});

const exportBody = z.object({
  destinationDirectory: z.string().min(1),
});

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.json': 'application/json',
  '.model3.json': 'application/json', '.moc3': 'application/octet-stream',
  '.zip': 'application/zip',
};

/** 角色资源文件流式返回；路径一律由 CharacterStore 解析，前端不传路径。 */
function serveFile(context: Context, filePath: string): Response {
  if (!fs.existsSync(filePath)) {
    return context.json({ error: 'resource_file_missing' }, 404);
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return new Response(fs.readFileSync(filePath), {
    headers: { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Cache-Control': 'no-store' },
  });
}

export const characterResourcesRoute = (deps: CharacterResourcesRouteDeps) => {
  const run = async (
    context: Context,
    action: () => unknown | Promise<unknown>,
  ): Promise<Response> => {
    try {
      const result = await action();
      if (result === undefined) return context.json({ error: 'resource_not_found' }, 404);
      return context.json(result);
    } catch (error) {
      return characterError(context, error);
    }
  };

  return new Hono()
    // ── Live2D ─────────────────────────────────────────────────────────────────
    .post('/:id/live2d/:resourceId/primary', context =>
      run(context, () => ({ ok: deps.characters.setPrimaryLive2dModel(context.req.param('id'), context.req.param('resourceId')) })))
    .patch('/:id/live2d/:resourceId', jsonBody(resourcePatch), async context =>
      run(context, () => deps.characters.updateLive2dModel(context.req.param('id'), context.req.param('resourceId'), context.req.valid('json'))))
    .post('/:id/live2d/import', jsonBody(importLive2dBody), async context =>
      run(context, async () => deps.characters.importLive2dModel(context.req.param('id'), context.req.valid('json'))))
    .post('/:id/live2d/:resourceId/export', jsonBody(exportBody), async context =>
      run(context, async () => ({ exported: await deps.characters.exportLive2dModel(context.req.param('id'), context.req.param('resourceId'), context.req.valid('json').destinationDirectory) })))
    .delete('/:id/live2d/:resourceId', context =>
      run(context, async () => {
        const deleted = await deps.characters.deleteLive2dModel(context.req.param('id'), context.req.param('resourceId'));
        return deleted ? { ok: true as const } : undefined;
      }))
    // Live2D 渲染器按相对路径取模型目录内文件；越界一律 404。
    .get('/:id/live2d/:resourceId/files/*', context => {
      let directory: string;
      try {
        directory = deps.characters.resolveLive2dModelDirectory(context.req.param('id'), context.req.param('resourceId'));
      } catch (error) {
        return characterError(context, error);
      }
      const relative = context.req.path.split('/files/')[1] ?? '';
      const resolved = path.resolve(directory, ...relative.split('/'));
      const rel = path.relative(path.resolve(directory), resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel) || relative.includes('\0')) {
        return context.json({ error: 'resource_not_found' }, 404);
      }
      return serveFile(context, resolved);
    })
    // ── 立绘 ───────────────────────────────────────────────────────────────────
    .post('/:id/illustrations/:resourceId/primary', context =>
      run(context, () => ({ ok: deps.characters.setPrimaryIllustration(context.req.param('id'), context.req.param('resourceId')) })))
    .patch('/:id/illustrations/:resourceId', jsonBody(resourcePatch), async context =>
      run(context, () => deps.characters.updateIllustration(context.req.param('id'), context.req.param('resourceId'), context.req.valid('json'))))
    .post('/:id/illustrations/import', jsonBody(importFileBody), async context =>
      run(context, async () => deps.characters.importIllustration(context.req.param('id'), context.req.valid('json'))))
    .post('/:id/illustrations/:resourceId/export', jsonBody(exportBody), async context =>
      run(context, async () => ({ exported: await deps.characters.exportIllustration(context.req.param('id'), context.req.param('resourceId'), context.req.valid('json').destinationDirectory) })))
    .delete('/:id/illustrations/:resourceId', context =>
      run(context, async () => {
        const deleted = await deps.characters.deleteIllustration(context.req.param('id'), context.req.param('resourceId'));
        return deleted ? { ok: true as const } : undefined;
      }))
    .get('/:id/illustrations/:resourceId/file', context => {
      try {
        return serveFile(context, deps.characters.resolveIllustrationFile(context.req.param('id'), context.req.param('resourceId')));
      } catch (error) {
        return characterError(context, error);
      }
    })
    // ── 参考音频 ───────────────────────────────────────────────────────────────
    .post('/:id/voice/:resourceId/primary', context =>
      run(context, () => ({ ok: deps.characters.setPrimaryVoiceSample(context.req.param('id'), context.req.param('resourceId')) })))
    .patch('/:id/voice/:resourceId', jsonBody(resourcePatch), async context =>
      run(context, () => deps.characters.updateVoiceSample(context.req.param('id'), context.req.param('resourceId'), context.req.valid('json'))))
    .post('/:id/voice/import', jsonBody(importVoiceBody), async context =>
      run(context, async () => deps.characters.importVoiceSample(context.req.param('id'), context.req.valid('json'))))
    // 录音/合成直传：multipart file 为音频字节，文本字段随表单。
    .post('/:id/voice/publish', async context => {
      const form = await context.req.formData().catch(() => null);
      const file = form?.get('file');
      const promptText = form?.get('promptText');
      const promptLang = form?.get('promptLang');
      if (!(file instanceof File) || file.size === 0 || typeof promptText !== 'string' || !promptText.trim()) {
        return context.json({ error: 'invalid_request' }, 400);
      }
      return run(context, async () => deps.characters.publishVoiceSample(context.req.param('id'), {
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name || 'voice.wav',
        promptText,
        promptLang: typeof promptLang === 'string' && promptLang.trim() ? promptLang : 'zh',
        ...((form?.get('isPrimary') === 'true') ? { isPrimary: true } : {}),
      }));
    })
    .post('/:id/voice/:resourceId/export', jsonBody(exportBody), async context =>
      run(context, async () => ({ exported: await deps.characters.exportVoiceSample(context.req.param('id'), context.req.param('resourceId'), context.req.valid('json').destinationDirectory) })))
    .delete('/:id/voice/:resourceId', context =>
      run(context, async () => {
        const deleted = await deps.characters.deleteVoiceSample(context.req.param('id'), context.req.param('resourceId'));
        return deleted ? { ok: true as const } : undefined;
      }))
    .get('/:id/voice/:resourceId/file', context => {
      try {
        return serveFile(context, deps.characters.resolveVoiceSampleFile(context.req.param('id'), context.req.param('resourceId')));
      } catch (error) {
        return characterError(context, error);
      }
    });
};
