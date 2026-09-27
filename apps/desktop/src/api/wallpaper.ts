// 浏览器通过文件上传接口管理图库, 原图和缩略图由独立资源接口读取.
import { rpcClient, readRpcJson, serverClient, type RpcClient, type RpcJson } from './client.js';
import type { WallpaperWindowTarget } from '@ema-agent/server/settings/wallpaperCatalog.js';

export type WallpaperImageSummary = RpcJson<RpcClient['api']['settings']['wallpaper']['images'][':target']['$get']>['items'][number];

export const wallpaperApi = {
  async uploadImage(target: WallpaperWindowTarget, file: File): Promise<WallpaperImageSummary > {
    const form = new FormData();
    form.set('target', target);
    form.set('file', file);
    const response = await serverClient.requestRaw('/api/settings/wallpaper/images', {
      method: 'POST',
      body: form,
    });
    return response.json() as Promise<WallpaperImageSummary>;
  },

  listImages(target: WallpaperWindowTarget): Promise<{ items: WallpaperImageSummary[] }> {
    return readRpcJson(rpcClient.api.settings.wallpaper.images[':target'].$get({
      param: { target },
    }));
  },

  renameImage(target: WallpaperWindowTarget, name: string, baseName: string): Promise<WallpaperImageSummary> {
    return readRpcJson(rpcClient.api.settings.wallpaper.images[':target'][':name'].$put({
      param: { target, name },
      json: { baseName },
    }));
  },

  removeImage(target: WallpaperWindowTarget, name: string): Promise<{ ok: boolean }> {
    return readRpcJson(rpcClient.api.settings.wallpaper.images[':target'][':name'].$delete({
      param: { target, name },
    }));
  },

  imagePath(target: WallpaperWindowTarget, name: string): string {
    return `/api/settings/wallpaper/images/${target}/${encodeURIComponent(name)}`;
  },

  thumbnailPath(target: WallpaperWindowTarget, name: string): string {
    return `/api/settings/wallpaper/images/${target}/${encodeURIComponent(name)}/thumbnail`;
  },
};
