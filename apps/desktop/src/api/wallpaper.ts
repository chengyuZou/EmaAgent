import { rpcClient, readRpcJson, serverClient, type RpcClient, type RpcJson } from './client.js';

export type WallpaperImageSummary = RpcJson<RpcClient['api']['settings']['wallpaper']['images']['$get']>['items'][number];

export const wallpaperApi = {
  async uploadImage(file: File): Promise<WallpaperImageSummary> {
    const form = new FormData();
    form.set('file', file);
    const response = await serverClient.requestRaw('/api/settings/wallpaper/images', {
      method: 'POST',
      body: form,
    });
    return response.json() as Promise<WallpaperImageSummary>;
  },

  listImages(): Promise<{ items: WallpaperImageSummary[] }> {
    return readRpcJson(rpcClient.api.settings.wallpaper.images.$get());
  },

  renameImage(name: string, baseName: string): Promise<WallpaperImageSummary> {
    return readRpcJson(rpcClient.api.settings.wallpaper.images[':name'].$put({
      param: { name },
      json: { baseName },
    }));
  },

  removeImage(name: string): Promise<{ ok: boolean }> {
    return readRpcJson(rpcClient.api.settings.wallpaper.images[':name'].$delete({
      param: { name },
    }));
  },

  imagePath(name: string): string {
    return `/api/settings/wallpaper/images/${encodeURIComponent(name)}`;
  },

  thumbnailPath(name: string): string {
    return `/api/settings/wallpaper/images/${encodeURIComponent(name)}/thumbnail`;
  },
};
