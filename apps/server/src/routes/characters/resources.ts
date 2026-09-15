// 角色三类资源（Live2D/立绘/参考音频）的管理与文件服务。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface CharacterResourcesRouteDeps {
  readonly characters: Pick<
    CharacterStore,
    | 'setPrimaryLive2dModel'
    | 'updateLive2dModel'
    | 'prepareLive2dImport'
    | 'streamPreparedLive2dArchive'
    | 'commitLive2dImport'
    | 'cancelLive2dImport'
    | 'exportLive2dModel'
    | 'deleteLive2dModel'
    | 'resolveLive2dModelDirectory'
    | 'streamLive2dArchive'
    | 'reloadLive2dConfiguration'
    | 'readLive2dConfiguration'
    | 'saveLive2dMappings'
    | 'setPrimaryIllustration'
    | 'updateIllustration'
    | 'importIllustration'
    | 'exportIllustration'
    | 'deleteIllustration'
    | 'resolveIllustrationFile'
    | 'setPrimaryVoiceSample'
    | 'updateVoiceSample'
    | 'importVoiceSample'
    | 'exportVoiceSample'
    | 'deleteVoiceSample'
    | 'resolveVoiceSampleFile'
    | 'resolveCharacterDirectory'
    | 'resolveLive2dPreviewFile'
    | 'saveLive2dPreview'
  >;
  readonly runWhenSessionsIdle: <T>(action: () => T | Promise<T>) => Promise<T>;
}

const resourcePatch = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  stageScale: z.number().min(0.1).max(5).optional(),
  stageOffsetX: z.number().min(-1).max(1).optional(),
  stageOffsetY: z.number().min(-1).max(1).optional(),
});

const illustrationPatch = resourcePatch.extend({
  expression: z.string().regex(/^[a-z][a-z0-9_]*$/u).nullable().optional(),
});

const voicePatch = z.object({ displayName: z.string().trim().min(1).max(200) });

const prepareLive2dImportBody = z.object({
  source: z.string().min(1),
}).strict();

const commitLive2dImportBody = z.object({
  previewPngBase64: z.string().min(1).max(4_000_000),
}).strict();

const previewBody = z.object({
  // 离屏渲出的封面 PNG(base64);预览图很小,4M 字符上限只是基础边界。
  dataBase64: z.string().min(1).max(4_000_000),
});

const importFileBody = z.object({
  sourceFile: z.string().min(1),
}).strict();

const importIllustrationBody = importFileBody.extend({
  expression: z.string().regex(/^[a-z][a-z0-9_]*$/u).nullable().optional(),
});

const importVoiceBody = importFileBody.extend({
  promptText: z.string().min(1).max(4_000),
  promptLang: z.string().min(1).max(32),
});

const exportBody = z.object({
  destinationDirectory: z.string().min(1),
});

const vocabularyName = /^[a-z][a-z0-9_]*$/u;
const live2dMappingsBody = z.object({
  emotionMap: z.record(z.string().regex(vocabularyName), z.object({ expression: z.string().min(1) })),
  motionMap: z.record(z.string().regex(vocabularyName), z.object({
    group: z.string().min(1),
    index: z.number().int().min(0),
  })),
});

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** 角色资源文件流式返回；路径一律由 CharacterStore 解析，前端不传路径。 */
async function serveFile(context: Context, filePath: string): Promise<Response> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    return context.json({ error: 'resource_file_missing' }, 404);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
  return new Response(body, {
    headers: { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Cache-Control': 'no-store' },
  });
}

export const characterResourcesRoute = (deps: CharacterResourcesRouteDeps) => {
  // 泛型必须流出：标成 Promise<Response> 会把所有经 run 的 JSON 响应擦成 unknown。
  const run = async <T extends {}>(
    context: Context,
    action: () => T | undefined | Promise<T | undefined>,
  ) => {
    try {
      const result = await action();
      if (result === undefined) return context.json({ error: 'resource_not_found' }, 404);
      return context.json(result);
    } catch (error) {
      return characterError(context, error);
    }
  };

  const whenSessionsIdle = async <T extends {}>(
    context: Context,
    action: () => T | undefined | Promise<T | undefined>,
  ) => {
    return run(context, () => deps.runWhenSessionsIdle(action));
  };

  return new Hono()
    .get('/:characterName/location', context =>
      run(context, () => ({
        path: deps.characters.resolveCharacterDirectory(context.req.param('characterName')),
      })))
    // ── Live2D ─────────────────────────────────────────────────────────────────
    // 暂存导入必须写在 `:live2dName` 路由之前,否则 imports 会被当成已安装模型名。
    // prepare 只校验和暂存,commit 才让数据库、模型目录与封面同时对其他窗口可见。
    .post('/:characterName/live2d/imports', jsonBody(prepareLive2dImportBody), context =>
      run(context, () => deps.characters.prepareLive2dImport(
        context.req.param('characterName'),
        context.req.valid('json'),
      )))
    .get('/:characterName/live2d/imports/:importId/archive', context => {
      try {
        const archive = deps.characters.streamPreparedLive2dArchive(
          context.req.param('characterName'),
          context.req.param('importId'),
        );
        return new Response(Readable.toWeb(archive) as ReadableStream, {
          headers: {
            'Content-Type': 'application/zip',
            'Cache-Control': 'no-store',
          },
        });
      } catch (error) {
        return characterError(context, error);
      }
    })
    .post(
      '/:characterName/live2d/imports/:importId/commit',
      jsonBody(commitLive2dImportBody),
      context => run(context, () => deps.characters.commitLive2dImport(
        context.req.param('characterName'),
        context.req.param('importId'),
        Buffer.from(context.req.valid('json').previewPngBase64, 'base64'),
      )),
    )
    .delete('/:characterName/live2d/imports/:importId', context =>
      run(context, async () => {
        await deps.characters.cancelLive2dImport(
          context.req.param('characterName'),
          context.req.param('importId'),
        );
        return { ok: true as const };
      }))
    .post('/:characterName/live2d/:live2dName/primary', context =>
      whenSessionsIdle(context, async () => ({
        ok: await deps.characters.setPrimaryLive2dModel(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        ),
      })))
    .patch('/:characterName/live2d/:live2dName', jsonBody(resourcePatch), context =>
      run(context, () => deps.characters.updateLive2dModel(
        context.req.param('characterName'),
        context.req.param('live2dName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/live2d/:live2dName/export', jsonBody(exportBody), context =>
      run(context, async () => ({
        exported: await deps.characters.exportLive2dModel(
          context.req.param('characterName'),
          context.req.param('live2dName'),
          context.req.valid('json').destinationDirectory,
        ),
      })))
    .delete('/:characterName/live2d/:live2dName', context =>
      whenSessionsIdle(context, async () => {
        const deleted = await deps.characters.deleteLive2dModel(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        );
        return deleted ? { ok: true as const } : undefined;
      }))
    // 用户手改 runtime-config.json 后显式校验并广播演出变化。
    .post('/:characterName/live2d/:live2dName/reload-config', context =>
      run(context, () => deps.characters.reloadLive2dConfiguration(
        context.req.param('characterName'),
        context.req.param('live2dName'),
      )))
    .get('/:characterName/live2d/:live2dName/configuration', context =>
      run(context, () => deps.characters.readLive2dConfiguration(
        context.req.param('characterName'),
        context.req.param('live2dName'),
      )))
    .get('/:characterName/live2d/:live2dName/location', context =>
      run(context, () => ({ path: deps.characters.resolveLive2dModelDirectory(
        context.req.param('characterName'),
        context.req.param('live2dName'),
      ) })))
    .get('/:characterName/live2d/:live2dName/archive', context => {
      try {
        const archive = deps.characters.streamLive2dArchive(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        );
        return new Response(Readable.toWeb(archive) as ReadableStream, {
          headers: {
            'Content-Type': 'application/zip',
            'Cache-Control': 'no-store',
          },
        });
      } catch (error) {
        return characterError(context, error);
      }
    })
    .put('/:characterName/live2d/:live2dName/configuration', jsonBody(live2dMappingsBody), context =>
      run(context, () => deps.characters.saveLive2dMappings(
        context.req.param('characterName'),
        context.req.param('live2dName'),
        context.req.valid('json'),
      )))
    // Live2D 静态封面:PUT 收离屏渲染的 PNG,GET 读字节;与模型目录分离(不污染用户模型包)。
    .put('/:characterName/live2d/:live2dName/preview', jsonBody(previewBody), context => {
      const png = Buffer.from(context.req.valid('json').dataBase64, 'base64');
      return run(context, async () => {
        await deps.characters.saveLive2dPreview(
          context.req.param('characterName'),
          context.req.param('live2dName'),
          png,
        );
        return { ok: true as const };
      });
    })
    .get('/:characterName/live2d/:live2dName/preview', context => {
      let filePath: string;
      try {
        filePath = deps.characters.resolveLive2dPreviewFile(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        );
      } catch (error) {
        return characterError(context, error);
      }
      return serveFile(context, filePath);
    })
    // ── 立绘 ───────────────────────────────────────────────────────────────────
    .post('/:characterName/illustrations/:illustrationName/primary', context =>
      run(context, async () => ({
        ok: await deps.characters.setPrimaryIllustration(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        ),
      })))
    .patch('/:characterName/illustrations/:illustrationName', jsonBody(illustrationPatch), context =>
      run(context, () => deps.characters.updateIllustration(
        context.req.param('characterName'),
        context.req.param('illustrationName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/illustrations/import', jsonBody(importIllustrationBody), context =>
      run(context, () => deps.characters.importIllustration(
        context.req.param('characterName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/illustrations/:illustrationName/export', jsonBody(exportBody), context =>
      run(context, async () => ({
        exported: await deps.characters.exportIllustration(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
          context.req.valid('json').destinationDirectory,
        ),
      })))
    .delete('/:characterName/illustrations/:illustrationName', context =>
      whenSessionsIdle(context, async () => {
        const deleted = await deps.characters.deleteIllustration(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        );
        return deleted ? { ok: true as const } : undefined;
      }))
    .get('/:characterName/illustrations/:illustrationName/file', context => {
      try {
        return serveFile(context, deps.characters.resolveIllustrationFile(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        ));
      } catch (error) {
        return characterError(context, error);
      }
    })
    .get('/:characterName/illustrations/:illustrationName/location', context =>
      run(context, () => ({
        path: deps.characters.resolveIllustrationFile(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        ),
      })))
    // ── 参考音频 ───────────────────────────────────────────────────────────────
    .post('/:characterName/voice/:voiceName/primary', context =>
      whenSessionsIdle(context, async () => ({
        ok: await deps.characters.setPrimaryVoiceSample(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        ),
      })))
    .patch('/:characterName/voice/:voiceName', jsonBody(voicePatch), context =>
      run(context, () => deps.characters.updateVoiceSample(
        context.req.param('characterName'),
        context.req.param('voiceName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/voice/import', jsonBody(importVoiceBody), context =>
      run(context, () => deps.characters.importVoiceSample(
        context.req.param('characterName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/voice/:voiceName/export', jsonBody(exportBody), context =>
      run(context, async () => ({
        exported: await deps.characters.exportVoiceSample(
          context.req.param('characterName'),
          context.req.param('voiceName'),
          context.req.valid('json').destinationDirectory,
        ),
      })))
    .delete('/:characterName/voice/:voiceName', context =>
      whenSessionsIdle(context, async () => {
        const deleted = await deps.characters.deleteVoiceSample(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        );
        return deleted ? { ok: true as const } : undefined;
      }))
    .get('/:characterName/voice/:voiceName/file', context => {
      try {
        return serveFile(context, deps.characters.resolveVoiceSampleFile(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        ));
      } catch (error) {
        return characterError(context, error);
      }
    })
    .get('/:characterName/voice/:voiceName/location', context =>
      run(context, () => ({
        path: deps.characters.resolveVoiceSampleFile(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        ),
      })));
};
