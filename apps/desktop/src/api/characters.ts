// Characters API：/api/characters——角色 CRUD/激活/复制、Live2D/立绘/参考音频资源管理与
// 健康/呈现快照。资源文件流与 voice/publish multipart 走 requestRaw/streamUrl 逃生口。
import type { InferRequestType } from 'hono/client';
import {
  rpcClient,
  readRpcJson,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type CharacterList = RpcJson<RpcClient['api']['characters']['$get']>;
export type Character = CharacterList['items'][number];
export type CharacterCreateInput = InferRequestType<RpcClient['api']['characters']['$post']>['json'];
export type CharacterPatchInput = InferRequestType<RpcClient['api']['characters'][':id']['$patch']>['json'];
export type CharacterHealthList = RpcJson<RpcClient['api']['characters']['health']['$get']>;
export type CharacterHealth = RpcJson<RpcClient['api']['characters'][':id']['health']['$get']>;
export type CharacterPresentation = RpcJson<RpcClient['api']['characters'][':id']['presentation']['$get']>;
export type Live2dImportInput = InferRequestType<RpcClient['api']['characters'][':id']['live2d']['import']['$post']>['json'];
export type Live2dImportResult = RpcJson<RpcClient['api']['characters'][':id']['live2d']['import']['$post']>;
export type VoiceImportInput = InferRequestType<RpcClient['api']['characters'][':id']['voice']['import']['$post']>['json'];
export type VoiceImportResult = RpcJson<RpcClient['api']['characters'][':id']['voice']['import']['$post']>;
export type VoicePublishResult = RpcJson<RpcClient['api']['characters'][':id']['voice']['publish']['$post']>;
export type ResourcePatchInput = InferRequestType<RpcClient['api']['characters'][':id']['live2d'][':resourceId']['$patch']>['json'];

// ── API ──────────────────────────────────────────────────────────────────────

export const charactersApi = {
  list(): Promise<CharacterList> {
    return readRpcJson(rpcClient.api.characters.$get());
  },

  /** 当前激活角色。 */
  current(): Promise<Character> {
    return readRpcJson(rpcClient.api.characters.current.$get());
  },

  get(id: string): Promise<Character> {
    return readRpcJson(rpcClient.api.characters[':id'].$get({ param: { id } }));
  },

  create(body: CharacterCreateInput) {
    return readRpcJson(rpcClient.api.characters.$post({ json: body }));
  },

  patch(id: string, patch: CharacterPatchInput): Promise<Character> {
    return readRpcJson(rpcClient.api.characters[':id'].$patch({ json: patch, param: { id } }));
  },

  activate(id: string) {
    return readRpcJson(rpcClient.api.characters[':id'].activate.$post({ param: { id } }));
  },

  duplicate(id: string) {
    return readRpcJson(rpcClient.api.characters[':id'].duplicate.$post({ param: { id } }));
  },

  /** 删除非活动角色（连同资源目录走 .trash）；活动角色服务端拒绝。 */
  remove(id: string) {
    return readRpcJson(rpcClient.api.characters[':id'].$delete({ param: { id } }));
  },

  /** 全部角色健康快照。 */
  healthAll(): Promise<CharacterHealthList> {
    return readRpcJson(rpcClient.api.characters.health.$get());
  },

  health(id: string): Promise<CharacterHealth> {
    return readRpcJson(rpcClient.api.characters[':id'].health.$get({ param: { id } }));
  },

  /** 舞台呈现快照（展示候选顺序由后端冻结，前端不自行扫描）。 */
  getPresentation(id: string): Promise<CharacterPresentation> {
    return readRpcJson(rpcClient.api.characters[':id'].presentation.$get({ param: { id } }));
  },

  // ── Live2D ─────────────────────────────────────────────────────────────────

  setLive2dPrimary(id: string, resourceId: string) {
    return readRpcJson(
      rpcClient.api.characters[':id'].live2d[':resourceId'].primary.$post({
        param: { id, resourceId },
      }),
    );
  },

  importLive2d(id: string, body: Live2dImportInput): Promise<Live2dImportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].live2d.import.$post({
      json: body,
      param: { id },
    }));
  },

  /** Live2D 渲染器取模型目录内文件的流式 URL。 */
  getLive2dFileUrl(id: string, resourceId: string, subPath: string): Promise<string> {
    return serverClient.streamUrl(
      `/api/characters/${id}/live2d/${resourceId}/files/${encodeURIComponent(subPath)}`,
    );
  },

  // ── 参考音频 ────────────────────────────────────────────────────────────────

  importVoice(id: string, body: VoiceImportInput): Promise<VoiceImportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].voice.import.$post({
      json: body,
      param: { id },
    }));
  },

  /** 录音/合成直传参考音频：multipart（file=音频字节，文本字段随表单）。 */
  async publishVoice(
    id: string,
    file: File,
    meta: { promptText: string; promptLang: string; isPrimary?: boolean },
  ): Promise<VoicePublishResult> {
    const form = new FormData();
    form.append('file', file);
    form.append('promptText', meta.promptText);
    form.append('promptLang', meta.promptLang);
    if (meta.isPrimary) form.append('isPrimary', 'true');
    const res = await serverClient.requestRaw(`/api/characters/${id}/voice/publish`, {
      method: 'POST',
      body: form,
    });
    return res.json();
  },

  /** 参考音频字节流 URL。 */
  getVoiceFileUrl(id: string, resourceId: string): Promise<string> {
    return serverClient.streamUrl(`/api/characters/${id}/voice/${resourceId}/file`);
  },
};
