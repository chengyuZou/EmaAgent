// Characters API：/api/characters——角色 CRUD/激活、Live2D/插图/参考音频资源管理与舞台呈现。
// 全部身份为稳定 name:characterName 是角色身份,live2dName/illustrationName/voiceName
// 只是路径段名,资源对象的稳定字段统一叫 name。不存在 id/resourceId/enabled/Duplicate。
import type { InferRequestType } from 'hono/client';
import {
  rpcClient,
  readRpcJson,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type CharacterList = RpcJson<RpcClient['api']['characters']['$get']>;
export type Character = CharacterList['items'][number];
export type CharacterCreateInput = InferRequestType<RpcClient['api']['characters']['$post']>['json'];
export type CharacterPatchInput = InferRequestType<RpcClient['api']['characters'][':characterName']['$patch']>['json'];
export type CharacterPresentation = RpcJson<RpcClient['api']['characters'][':characterName']['presentation']['$get']>;
export type Live2dConfiguration = RpcJson<RpcClient['api']['characters'][':characterName']['live2d'][':live2dName']['configuration']['$get']>;
export type Live2dMappingsInput = InferRequestType<RpcClient['api']['characters'][':characterName']['live2d'][':live2dName']['configuration']['$put']>['json'];
export type Live2dImportInput = InferRequestType<RpcClient['api']['characters'][':characterName']['live2d']['import']['$post']>['json'];
export type IllustrationImportInput = InferRequestType<RpcClient['api']['characters'][':characterName']['illustrations']['import']['$post']>['json'];
export type VoiceImportInput = InferRequestType<RpcClient['api']['characters'][':characterName']['voice']['import']['$post']>['json'];
export type ResourcePatchInput = InferRequestType<RpcClient['api']['characters'][':characterName']['live2d'][':live2dName']['$patch']>['json'];
export type IllustrationPatchInput = InferRequestType<RpcClient['api']['characters'][':characterName']['illustrations'][':illustrationName']['$patch']>['json'];
export type VoicePatchInput = InferRequestType<RpcClient['api']['characters'][':characterName']['voice'][':voiceName']['$patch']>['json'];

// ── API ──────────────────────────────────────────────────────────────────────

export const charactersApi = {
  list(): Promise<CharacterList> {
    return readRpcJson(rpcClient.api.characters.$get());
  },

  current(): Promise<Character> {
    return readRpcJson(rpcClient.api.characters.current.$get());
  },

  get(name: string): Promise<Character> {
    return readRpcJson(rpcClient.api.characters[':characterName'].$get({
      param: { characterName: name },
    }));
  },

  create(input: CharacterCreateInput): Promise<Character> {
    return readRpcJson(rpcClient.api.characters.$post({ json: input }));
  },

  patch(name: string, input: CharacterPatchInput): Promise<Character> {
    return readRpcJson(rpcClient.api.characters[':characterName'].$patch({
      param: { characterName: name },
      json: input,
    }));
  },

  async activate(name: string): Promise<void> {
    await readRpcJson(rpcClient.api.characters[':characterName'].activate.$post({
      param: { characterName: name },
    }));
  },

  /** 永久删除角色;删除当前角色后自动激活最近使用的其他角色。 */
  async remove(name: string): Promise<void> {
    await readRpcJson(rpcClient.api.characters[':characterName'].$delete({
      param: { characterName: name },
    }));
  },

  presentation(name: string): Promise<CharacterPresentation> {
    return readRpcJson(rpcClient.api.characters[':characterName'].presentation.$get({
      param: { characterName: name },
    }));
  },

  location(name: string): Promise<{ path: string }> {
    return readRpcJson(rpcClient.api.characters[':characterName'].location.$get({
      param: { characterName: name },
    }));
  },

  // ── Live2D ─────────────────────────────────────────────────────────────────

  importLive2d(characterName: string, input: Live2dImportInput) {
    return readRpcJson(rpcClient.api.characters[':characterName'].live2d.import.$post({
      param: { characterName },
      json: input,
    }));
  },

  patchLive2d(characterName: string, live2dName: string, input: ResourcePatchInput) {
    return readRpcJson(rpcClient.api.characters[':characterName'].live2d[':live2dName'].$patch({
      param: { characterName, live2dName },
      json: input,
    }));
  },

  setPrimaryLive2d(characterName: string, live2dName: string) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].live2d[':live2dName'].primary.$post({
        param: { characterName, live2dName },
      }),
    );
  },

  exportLive2d(characterName: string, live2dName: string, destinationDirectory: string) {
    return readRpcJson(rpcClient.api.characters[':characterName'].live2d[':live2dName'].export.$post({
      param: { characterName, live2dName },
      json: { destinationDirectory },
    }));
  },

  deleteLive2d(characterName: string, live2dName: string) {
    return readRpcJson(rpcClient.api.characters[':characterName'].live2d[':live2dName'].$delete({
      param: { characterName, live2dName },
    }));
  },

  live2dConfiguration(characterName: string, live2dName: string): Promise<Live2dConfiguration> {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].live2d[':live2dName'].configuration.$get({
        param: { characterName, live2dName },
      }),
    );
  },

  saveLive2dMappings(characterName: string, live2dName: string, input: Live2dMappingsInput) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].live2d[':live2dName'].configuration.$put({
        param: { characterName, live2dName },
        json: input,
      }),
    );
  },

  reloadLive2dConfig(characterName: string, live2dName: string) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].live2d[':live2dName']['reload-config'].$post({
        param: { characterName, live2dName },
      }),
    );
  },

  live2dLocation(characterName: string, live2dName: string): Promise<{ path: string }> {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].live2d[':live2dName'].location.$get({
        param: { characterName, live2dName },
      }),
    );
  },

  /** Live2D 静态封面:导入或用户重试时前端离屏渲一帧的 PNG 上传;读取走同源 URL。 */
  async uploadLive2dPreview(characterName: string, live2dName: string, dataBase64: string): Promise<void> {
    await readRpcJson(
      rpcClient.api.characters[':characterName'].live2d[':live2dName'].preview.$put({
        param: { characterName, live2dName },
        json: { dataBase64 },
      }),
    );
  },

  live2dPreviewUrl(characterName: string, live2dName: string): string {
    return `/api/characters/${encodeURIComponent(characterName)}/live2d/${encodeURIComponent(live2dName)}/preview`;
  },

  /** 模型目录以一个受认证的 ZIP 读取,包内相对引用由 Live2D 渲染器解析。 */
  async live2dArchive(characterName: string, live2dName: string): Promise<Blob> {
    const response = await serverClient.requestRaw(
      `/api/characters/${encodeURIComponent(characterName)}/live2d/${encodeURIComponent(live2dName)}/archive`,
    );
    return response.blob();
  },

  // ── 插图 ───────────────────────────────────────────────────────────────────

  importIllustration(characterName: string, input: IllustrationImportInput) {
    return readRpcJson(rpcClient.api.characters[':characterName'].illustrations.import.$post({
      param: { characterName },
      json: input,
    }));
  },

  patchIllustration(characterName: string, illustrationName: string, input: IllustrationPatchInput) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].illustrations[':illustrationName'].$patch({
        param: { characterName, illustrationName },
        json: input,
      }),
    );
  },

  setPrimaryIllustration(characterName: string, illustrationName: string) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].illustrations[':illustrationName'].primary.$post({
        param: { characterName, illustrationName },
      }),
    );
  },

  exportIllustration(characterName: string, illustrationName: string, destinationDirectory: string) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].illustrations[':illustrationName'].export.$post({
        param: { characterName, illustrationName },
        json: { destinationDirectory },
      }),
    );
  },

  deleteIllustration(characterName: string, illustrationName: string) {
    return readRpcJson(rpcClient.api.characters[':characterName'].illustrations[':illustrationName'].$delete({
      param: { characterName, illustrationName },
    }));
  },

  /** 单张插图原始文件是字节流,不进入 JSON RPC;设置页预览原图直接用它。 */
  illustrationFileUrl(characterName: string, illustrationName: string): string {
    return `/api/characters/${encodeURIComponent(characterName)}/illustrations/${encodeURIComponent(illustrationName)}/file`;
  },

  illustrationLocation(characterName: string, illustrationName: string): Promise<{ path: string }> {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].illustrations[':illustrationName'].location.$get({
        param: { characterName, illustrationName },
      }),
    );
  },

  // ── 参考音频 ───────────────────────────────────────────────────────────────

  importVoice(characterName: string, input: VoiceImportInput) {
    return readRpcJson(rpcClient.api.characters[':characterName'].voice.import.$post({
      param: { characterName },
      json: input,
    }));
  },

  patchVoice(characterName: string, voiceName: string, input: VoicePatchInput) {
    return readRpcJson(rpcClient.api.characters[':characterName'].voice[':voiceName'].$patch({
      param: { characterName, voiceName },
      json: input,
    }));
  },

  setPrimaryVoice(characterName: string, voiceName: string) {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].voice[':voiceName'].primary.$post({
        param: { characterName, voiceName },
      }),
    );
  },

  exportVoice(characterName: string, voiceName: string, destinationDirectory: string) {
    return readRpcJson(rpcClient.api.characters[':characterName'].voice[':voiceName'].export.$post({
      param: { characterName, voiceName },
      json: { destinationDirectory },
    }));
  },

  deleteVoice(characterName: string, voiceName: string) {
    return readRpcJson(rpcClient.api.characters[':characterName'].voice[':voiceName'].$delete({
      param: { characterName, voiceName },
    }));
  },

  /** 参考音频文件是字节流,不进入 JSON RPC;设置页播放直接用它。 */
  voiceFileUrl(characterName: string, voiceName: string): string {
    return `/api/characters/${encodeURIComponent(characterName)}/voice/${encodeURIComponent(voiceName)}/file`;
  },

  voiceLocation(characterName: string, voiceName: string): Promise<{ path: string }> {
    return readRpcJson(
      rpcClient.api.characters[':characterName'].voice[':voiceName'].location.$get({
        param: { characterName, voiceName },
      }),
    );
  },

  async openDirectory(absolutePath: string): Promise<void> {
    await tauriBridge.openPath(absolutePath);
  },

  async revealFile(absolutePath: string): Promise<void> {
    await tauriBridge.revealInFolder(absolutePath);
  },

  /** 供调用方拿到 server 原始响应的入口。 */
  requestRaw: serverClient.requestRaw.bind(serverClient),
};
