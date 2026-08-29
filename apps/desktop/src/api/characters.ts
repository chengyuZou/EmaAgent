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
export type IllustrationImportInput = InferRequestType<RpcClient['api']['characters'][':id']['illustrations']['import']['$post']>['json'];
export type IllustrationImportResult = RpcJson<RpcClient['api']['characters'][':id']['illustrations']['import']['$post']>;
export type VoiceImportInput = InferRequestType<RpcClient['api']['characters'][':id']['voice']['import']['$post']>['json'];
export type VoiceImportResult = RpcJson<RpcClient['api']['characters'][':id']['voice']['import']['$post']>;
export type VoicePublishResult = RpcJson<RpcClient['api']['characters'][':id']['voice']['publish']['$post']>;
export type ResourcePatchInput = InferRequestType<RpcClient['api']['characters'][':id']['live2d'][':resourceId']['$patch']>['json'];
export type Live2dExportResult = RpcJson<RpcClient['api']['characters'][':id']['live2d'][':resourceId']['export']['$post']>;
export type IllustrationExportResult = RpcJson<RpcClient['api']['characters'][':id']['illustrations'][':resourceId']['export']['$post']>;
export type VoiceExportResult = RpcJson<RpcClient['api']['characters'][':id']['voice'][':resourceId']['export']['$post']>;

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

  /** 编辑 Live2D 资源行（名称/舞台几何/启停）。 */
  patchLive2d(id: string, resourceId: string, patch: ResourcePatchInput) {
    return readRpcJson(rpcClient.api.characters[':id'].live2d[':resourceId'].$patch({
      json: patch,
      param: { id, resourceId },
    }));
  },

  /** 用户手改 runtime-config.json 后显式重读：词汇写回 SQL 并刷新舞台。 */
  reloadLive2dConfig(id: string, resourceId: string) {
    return readRpcJson(
      rpcClient.api.characters[':id'].live2d[':resourceId']['reload-config'].$post({
        param: { id, resourceId },
      }),
    );
  },

  /** 导出 Live2D 模型目录 zip 到目标目录。 */
  exportLive2d(id: string, resourceId: string, destinationDirectory: string): Promise<Live2dExportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].live2d[':resourceId'].export.$post({
      json: { destinationDirectory },
      param: { id, resourceId },
    }));
  },

  deleteLive2d(id: string, resourceId: string) {
    return readRpcJson(rpcClient.api.characters[':id'].live2d[':resourceId'].$delete({
      param: { id, resourceId },
    }));
  },

  /** Live2D 模型目录内文件的 URL 构造器：仅用于认证 fetch（取 blob/JSON），
      禁止直接塞进 <img>/<audio> 的 src（会 401）。 */
  getLive2dFileUrl(id: string, resourceId: string, subPath: string): Promise<string> {
    return serverClient.streamUrl(
      `/api/characters/${id}/live2d/${resourceId}/files/${encodeURIComponent(subPath)}`,
    );
  },

  // ── 立绘 ───────────────────────────────────────────────────────────────────

  setIllustrationPrimary(id: string, resourceId: string) {
    return readRpcJson(
      rpcClient.api.characters[':id'].illustrations[':resourceId'].primary.$post({
        param: { id, resourceId },
      }),
    );
  },

  importIllustration(id: string, body: IllustrationImportInput): Promise<IllustrationImportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].illustrations.import.$post({
      json: body,
      param: { id },
    }));
  },

  /** 编辑立绘资源行（名称/舞台几何/启停）。 */
  patchIllustration(id: string, resourceId: string, patch: ResourcePatchInput) {
    return readRpcJson(rpcClient.api.characters[':id'].illustrations[':resourceId'].$patch({
      json: patch,
      param: { id, resourceId },
    }));
  },

  exportIllustration(id: string, resourceId: string, destinationDirectory: string): Promise<IllustrationExportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].illustrations[':resourceId'].export.$post({
      json: { destinationDirectory },
      param: { id, resourceId },
    }));
  },

  deleteIllustration(id: string, resourceId: string) {
    return readRpcJson(rpcClient.api.characters[':id'].illustrations[':resourceId'].$delete({
      param: { id, resourceId },
    }));
  },

  /** 立绘图片文件的 URL 构造器：/api 路由要共享密钥头，只能用于认证 fetch（取 blob 转 objectURL），
      禁止直接塞进 <img>/<audio> 的 src（会 401）。 */
  getIllustrationFileUrl(id: string, resourceId: string): Promise<string> {
    return serverClient.streamUrl(`/api/characters/${id}/illustrations/${resourceId}/file`);
  },

  // ── 参考音频 ────────────────────────────────────────────────────────────────

  importVoice(id: string, body: VoiceImportInput): Promise<VoiceImportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].voice.import.$post({
      json: body,
      param: { id },
    }));
  },

  setVoicePrimary(id: string, resourceId: string) {
    return readRpcJson(
      rpcClient.api.characters[':id'].voice[':resourceId'].primary.$post({
        param: { id, resourceId },
      }),
    );
  },

  /** 编辑参考音频资源行（名称/启停；prompt 文本与语种不可改——重录代替修改）。 */
  patchVoice(id: string, resourceId: string, patch: ResourcePatchInput) {
    return readRpcJson(rpcClient.api.characters[':id'].voice[':resourceId'].$patch({
      json: patch,
      param: { id, resourceId },
    }));
  },

  exportVoice(id: string, resourceId: string, destinationDirectory: string): Promise<VoiceExportResult> {
    return readRpcJson(rpcClient.api.characters[':id'].voice[':resourceId'].export.$post({
      json: { destinationDirectory },
      param: { id, resourceId },
    }));
  },

  deleteVoice(id: string, resourceId: string) {
    return readRpcJson(rpcClient.api.characters[':id'].voice[':resourceId'].$delete({
      param: { id, resourceId },
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

  /** 参考音频文件的 URL 构造器：仅用于认证 fetch（取 blob 转 objectURL 播放），
      禁止直接塞进 <audio> 的 src（会 401）。 */
  getVoiceFileUrl(id: string, resourceId: string): Promise<string> {
    return serverClient.streamUrl(`/api/characters/${id}/voice/${resourceId}/file`);
  },
};
