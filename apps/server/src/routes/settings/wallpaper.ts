// 对浏览器提供壁纸上传, 摘要列表, 缩略图和原图读取接口.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { WallpaperImages } from '../../settings/wallpaperImages.js';
import { jsonBody } from '../validate.js';

export interface WallpaperRouteDeps {
  readonly images: WallpaperImages;
}

const renameBody = z.object({ baseName: z.string().trim().min(1).max(120) });

export const wallpaperRoute = (deps: WallpaperRouteDeps) =>
  new Hono()
    .post('/wallpaper/images', async context => {
      const form = await context.req.formData().catch(() => null);
      const target = form?.get('target');
      const file = form?.get('file');
      if ((target !== 'chat' && target !== 'settings') || !file || typeof file === 'string') {
        return context.json({ error: 'invalid_wallpaper_upload' }, 400);
      }
      const imported = await deps.images.import(target, file.name, Buffer.from(await file.arrayBuffer()));
      if (!imported) return context.json({ error: 'unsupported_image_type' }, 400);
      return context.json(imported);
    })
    .get('/wallpaper/images/:target', async context => {
      const target = readTarget(context.req.param('target'));
      if (!target) return context.json({ error: 'invalid_wallpaper_target' }, 400);
      return context.json({ items: await deps.images.list(target) });
    })
    .get('/wallpaper/images/:target/:name/thumbnail', async context => {
      const target = readTarget(context.req.param('target'));
      if (!target) return context.json({ error: 'invalid_wallpaper_target' }, 400);
      const bytes = await deps.images.thumbnail(target, context.req.param('name'));
      if (!bytes) return context.json({ error: 'wallpaper_missing' }, 404);
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' },
      });
    })
    .get('/wallpaper/images/:target/:name', async context => {
      const target = readTarget(context.req.param('target'));
      if (!target) return context.json({ error: 'invalid_wallpaper_target' }, 400);
      const file = await deps.images.get(target, context.req.param('name'));
      if (!file) return context.json({ error: 'wallpaper_missing' }, 404);
      const body = Readable.toWeb(fs.createReadStream(file.path)) as ReadableStream;
      return new Response(body, {
        headers: {
          'Content-Type': file.mime,
          'Content-Length': String(file.size),
          'Cache-Control': 'no-store',
        },
      });
    })
    .put('/wallpaper/images/:target/:name', jsonBody(renameBody), async context => {
      const target = readTarget(context.req.param('target'));
      if (!target) return context.json({ error: 'invalid_wallpaper_target' }, 400);
      const renamed = await deps.images.rename(
        target,
        context.req.param('name'),
        context.req.valid('json').baseName,
      );
      if (!renamed) return context.json({ error: 'wallpaper_missing' }, 404);
      return context.json(renamed);
    })
    .delete('/wallpaper/images/:target/:name', async context => {
      const target = readTarget(context.req.param('target'));
      if (!target) return context.json({ error: 'invalid_wallpaper_target' }, 400);
      const removed = await deps.images.remove(target, context.req.param('name'));
      if (!removed) return context.json({ error: 'wallpaper_missing' }, 404);
      return context.json({ ok: true });
    });

function readTarget(value: string): 'chat' | 'settings' | null {
  return value === 'chat' || value === 'settings' ? value : null;
}
