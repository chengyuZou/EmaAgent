import { CHARACTER_STICKER_PROMPT_MAX_CHARS } from '@ema-agent/characters/stickers';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CharacterStore } from '@ema-agent/characters';
import { REQUEST_VALUE_LIMITS } from '../../platform/requestBudget.js';
import { characterError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface CharacterResourcesRouteDeps {
  readonly characters: Pick<CharacterStore, 'live2dModels' | 'illustrations' | 'voiceSamples' | 'stickers' | 'resolveCharacterDirectory'>;
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

const voicePatch = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  promptText: z.string().trim().min(1).max(4_000).optional(),
  promptLang: z.string().trim().min(1).max(32).optional(),
});

const prepareLive2dImportBody = z.object({
  source: z.string().min(1),
}).strict();

// 编码长度的上限不能区分同一组 base64 内多出的 1-2 字节, 同时检查解码大小.
const previewPngBase64 = z.string().min(1)
  .max(Math.ceil(REQUEST_VALUE_LIMITS.maxLive2dPreviewBytes / 3) * 4)
  .refine(value => Buffer.byteLength(value, 'base64') <= REQUEST_VALUE_LIMITS.maxLive2dPreviewBytes, {
    message: 'Live2D preview PNG exceeds 100 MiB',
  });

const commitLive2dImportBody = z.object({
  previewPngBase64,
}).strict();

const previewBody = z.object({
  dataBase64: previewPngBase64,
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

/** 角色资源文件流式返回;路径一律由 CharacterStore 解析,前端不传路径. */
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
  // 泛型必须流出:标成 Promise<Response> 会把所有经 run 的 JSON 响应擦成 unknown.
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

  const runFile = async (context: Context, resolve: () => string): Promise<Response> => {
    try {
      return await serveFile(context, resolve());
    } catch (error) {
      return characterError(context, error);
    }
  };

  return new Hono()
    .post('/:characterName/stickers/import', jsonBody(importFileBody), context =>
      whenSessionsIdle(context, () => deps.characters.stickers.import(
        context.req.param('characterName'), context.req.valid('json').sourceFile,
      )))
    .patch('/:characterName/stickers/:stickerName', jsonBody(z.object({
      displayName: z.string().trim().min(1).max(200),
      description: z.string().max(CHARACTER_STICKER_PROMPT_MAX_CHARS),
    }).strict()), context =>
      whenSessionsIdle(context, () => deps.characters.stickers.update(
        context.req.param('characterName'), context.req.param('stickerName'), context.req.valid('json'),
      )))
    .delete('/:characterName/stickers/:stickerName', context =>
      whenSessionsIdle(context, async () => {
        await deps.characters.stickers.delete(context.req.param('characterName'), context.req.param('stickerName'));
        return { ok: true };
      }))
    .get('/:characterName/stickers/:stickerName/file', context =>
      runFile(context, () => deps.characters.stickers.resolveFile(context.req.param('characterName'), context.req.param('stickerName'))))
    .get('/:characterName/stickers/:stickerName/location', context =>
      run(context, () => ({ path: deps.characters.stickers.resolveFile(context.req.param('characterName'), context.req.param('stickerName')) })))
    .post('/:characterName/stickers/:stickerName/export', jsonBody(exportBody), context =>
      run(context, async () => ({ exported: await deps.characters.stickers.export(
        context.req.param('characterName'), context.req.param('stickerName'), context.req.valid('json').destinationDirectory,
      ) })))
    .get('/:characterName/location', context =>
      run(context, () => ({
        path: deps.characters.resolveCharacterDirectory(context.req.param('characterName')),
      })))
    // 暂存导入必须写在 `:live2dName` 路由之前,否则 imports 会被当成已安装模型名.
    // prepare 只校验和暂存,commit 才让数据库, 模型目录与封面同时对其他窗口可见.
    .post('/:characterName/live2d/imports', jsonBody(prepareLive2dImportBody), context =>
      run(context, () => deps.characters.live2dModels.prepareImport(
        context.req.param('characterName'),
        context.req.valid('json'),
      )))
    .get('/:characterName/live2d/imports/:importId/archive', context => {
      try {
        const archive = deps.characters.live2dModels.streamPreparedArchive(
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
      context => run(context, () => deps.characters.live2dModels.commitImport(
        context.req.param('characterName'),
        context.req.param('importId'),
        Buffer.from(context.req.valid('json').previewPngBase64, 'base64'),
      )),
    )
    .delete('/:characterName/live2d/imports/:importId', context =>
      run(context, async () => {
        await deps.characters.live2dModels.cancelImport(
          context.req.param('characterName'),
          context.req.param('importId'),
        );
        return { ok: true as const };
      }))
    .post('/:characterName/live2d/:live2dName/primary', context =>
      whenSessionsIdle(context, async () => ({
        ok: await deps.characters.live2dModels.setPrimary(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        ),
      })))
    .patch('/:characterName/live2d/:live2dName', jsonBody(resourcePatch), context =>
      run(context, () => deps.characters.live2dModels.update(
        context.req.param('characterName'),
        context.req.param('live2dName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/live2d/:live2dName/export', jsonBody(exportBody), context =>
      run(context, async () => ({
        exported: await deps.characters.live2dModels.export(
          context.req.param('characterName'),
          context.req.param('live2dName'),
          context.req.valid('json').destinationDirectory,
        ),
      })))
    .delete('/:characterName/live2d/:live2dName', context =>
      whenSessionsIdle(context, async () => {
        const deleted = await deps.characters.live2dModels.delete(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        );
        return deleted ? { ok: true as const } : undefined;
      }))
    // 用户手改 model3 或原生表情/动作文件后重新读取能力, 数据库映射保持不变.
    .post('/:characterName/live2d/:live2dName/reload-config', context =>
      run(context, () => deps.characters.live2dModels.reloadConfiguration(
        context.req.param('characterName'),
        context.req.param('live2dName'),
      )))
    .get('/:characterName/live2d/:live2dName/configuration', context =>
      run(context, () => deps.characters.live2dModels.readConfiguration(
        context.req.param('characterName'),
        context.req.param('live2dName'),
      )))
    .get('/:characterName/live2d/:live2dName/location', context =>
      run(context, () => ({ path: deps.characters.live2dModels.resolveDirectory(
        context.req.param('characterName'),
        context.req.param('live2dName'),
      ) })))
    .get('/:characterName/live2d/:live2dName/archive', context => {
      try {
        const archive = deps.characters.live2dModels.streamArchive(
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
      run(context, () => deps.characters.live2dModels.saveMappings(
        context.req.param('characterName'),
        context.req.param('live2dName'),
        context.req.valid('json'),
      )))
    // Live2D 静态封面:PUT 收离屏渲染的 PNG,GET 读字节;与模型目录分离(不污染用户模型包).
    .put('/:characterName/live2d/:live2dName/preview', jsonBody(previewBody), context => {
      const png = Buffer.from(context.req.valid('json').dataBase64, 'base64');
      return run(context, async () => {
        await deps.characters.live2dModels.savePreview(
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
        filePath = deps.characters.live2dModels.resolvePreviewFile(
          context.req.param('characterName'),
          context.req.param('live2dName'),
        );
      } catch (error) {
        return characterError(context, error);
      }
      return serveFile(context, filePath);
    })
    .post('/:characterName/illustrations/:illustrationName/primary', context =>
      run(context, async () => ({
        ok: await deps.characters.illustrations.setPrimary(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        ),
      })))
    .patch('/:characterName/illustrations/:illustrationName', jsonBody(illustrationPatch), context =>
      run(context, () => deps.characters.illustrations.update(
        context.req.param('characterName'),
        context.req.param('illustrationName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/illustrations/import', jsonBody(importIllustrationBody), context =>
      run(context, () => deps.characters.illustrations.import(
        context.req.param('characterName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/illustrations/:illustrationName/export', jsonBody(exportBody), context =>
      run(context, async () => ({
        exported: await deps.characters.illustrations.export(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
          context.req.valid('json').destinationDirectory,
        ),
      })))
    .delete('/:characterName/illustrations/:illustrationName', context =>
      whenSessionsIdle(context, async () => {
        const deleted = await deps.characters.illustrations.delete(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        );
        return deleted ? { ok: true as const } : undefined;
      }))
    .get('/:characterName/illustrations/:illustrationName/file', context => {
      try {
        return serveFile(context, deps.characters.illustrations.resolveFile(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        ));
      } catch (error) {
        return characterError(context, error);
      }
    })
    .get('/:characterName/illustrations/:illustrationName/location', context =>
      run(context, () => ({
        path: deps.characters.illustrations.resolveFile(
          context.req.param('characterName'),
          context.req.param('illustrationName'),
        ),
      })))
    .post('/:characterName/voice/:voiceName/primary', context =>
      whenSessionsIdle(context, async () => ({
        ok: await deps.characters.voiceSamples.setPrimary(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        ),
      })))
    .patch('/:characterName/voice/:voiceName', jsonBody(voicePatch), context =>
      run(context, () => deps.characters.voiceSamples.update(
        context.req.param('characterName'),
        context.req.param('voiceName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/voice/import', jsonBody(importVoiceBody), context =>
      run(context, () => deps.characters.voiceSamples.import(
        context.req.param('characterName'),
        context.req.valid('json'),
      )))
    .post('/:characterName/voice/:voiceName/export', jsonBody(exportBody), context =>
      run(context, async () => ({
        exported: await deps.characters.voiceSamples.export(
          context.req.param('characterName'),
          context.req.param('voiceName'),
          context.req.valid('json').destinationDirectory,
        ),
      })))
    .delete('/:characterName/voice/:voiceName', context =>
      whenSessionsIdle(context, async () => {
        const deleted = await deps.characters.voiceSamples.delete(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        );
        return deleted ? { ok: true as const } : undefined;
      }))
    .get('/:characterName/voice/:voiceName/file', context => {
      try {
        return serveFile(context, deps.characters.voiceSamples.resolveFile(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        ));
      } catch (error) {
        return characterError(context, error);
      }
    })
    .get('/:characterName/voice/:voiceName/location', context =>
      run(context, () => ({
        path: deps.characters.voiceSamples.resolveFile(
          context.req.param('characterName'),
          context.req.param('voiceName'),
        ),
      })));
};
