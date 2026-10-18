import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WallpaperImages } from '../src/settings/wallpaperImages.js';
import { wallpaperRoute } from '../src/routes/settings/wallpaper.js';

let directory: string;
let images: WallpaperImages;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ema-wallpaper-test-'));
  images = new WallpaperImages(directory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function upload(name: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.set('file', new Blob([bytes]), name);
  return wallpaperRoute({ images }).request('/wallpaper/images', { method: 'POST', body: form });
}

describe('wallpaper image uploads', () => {
  it('rejects JSON both under its own name and disguised as a PNG', async () => {
    const bytes = Buffer.from('{"name":"package"}');
    for (const name of ['package.json', 'package.png']) {
      const response = await upload(name, bytes);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'unsupported_image_type' });
    }
    expect(await images.list()).toEqual([]);
  });

  it('saves a real image through the upload route and rejects a mismatched extension', async () => {
    const bytes = await sharp({ create: {
      width: 2, height: 2, channels: 4, background: '#ffffff',
    } }).png().toBuffer();
    expect((await upload('image.jpg', bytes)).status).toBe(400);
    const response = await upload('image.png', bytes);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'image.png', size: bytes.length });
    expect(await images.list()).toHaveLength(1);
  });
});
