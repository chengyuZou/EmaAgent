// Skills API：/api/skills——技能目录/详情/正文/删除 + 站点 CRUD/刷新/安装。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SkillListResult = RpcJson<RpcClient['api']['skills']['$get']>;
export type SkillListItem = SkillListResult['items'][number];
export type SkillDescriptorResult = RpcJson<RpcClient['api']['skills']['descriptor']['$get']>;
export type SkillContentResult = RpcJson<RpcClient['api']['skills']['content']['$get']>;
export type SkillSiteList = RpcJson<RpcClient['api']['skills']['sites']['$get']>;
export type SkillSiteRecord = SkillSiteList['items'][number];
export type SkillSiteAddInput = InferRequestType<RpcClient['api']['skills']['sites']['$post']>['json'];
export type SkillSitePatchInput = InferRequestType<RpcClient['api']['skills']['sites'][':id']['$patch']>['json'];
export type SkillSitesRefreshResult = RpcJson<RpcClient['api']['skills']['sites']['refresh']['$post']>;
export type SkillInstallInput = InferRequestType<RpcClient['api']['skills']['sites']['install']['$post']>['json'];
export type SkillInstallResult = RpcJson<RpcClient['api']['skills']['sites']['install']['$post']>;
export type SkillProjectSourceList = RpcJson<RpcClient['api']['skills']['sources']['$get']>;

/** sessionId 缺省时只见 builtin+user；project 技能按 Session 工作区合成。 */
const withSessionId = (sessionId: string | undefined) => (sessionId ? { sessionId } : {});

export const skillsApi = {
  listProjectSources(): Promise<SkillProjectSourceList> {
    return readRpcJson(rpcClient.api.skills.sources.$get());
  },

  /** GET /api/skills?sessionId= — 全量目录（含 enabled 投影）。 */
  list(sessionId?: string): Promise<SkillListResult> {
    return readRpcJson(rpcClient.api.skills.$get({ query: withSessionId(sessionId) }));
  },

  /** GET /api/skills/descriptor?key=&sessionId= — 单条详情（key 含冒号斜杠走 query）。 */
  get(key: string, sessionId?: string): Promise<SkillDescriptorResult> {
    return readRpcJson(rpcClient.api.skills.descriptor.$get({
      query: { key, ...withSessionId(sessionId) },
    }));
  },

  /** GET /api/skills/content?key=&sessionId= — SKILL.md 正文。 */
  getContent(key: string, sessionId?: string): Promise<SkillContentResult> {
    return readRpcJson(rpcClient.api.skills.content.$get({
      query: { key, ...withSessionId(sessionId) },
    }));
  },

  /** DELETE /api/skills?key=&sessionId= — 只有 user 技能可删。 */
  remove(key: string, sessionId?: string) {
    return readRpcJson(rpcClient.api.skills.$delete({
      query: { key, ...withSessionId(sessionId) },
    }));
  },

  // ── Sites（技能市场站点） ───────────────────────────────────────────────────

  listSites(): Promise<SkillSiteList> {
    return readRpcJson(rpcClient.api.skills.sites.$get());
  },

  addSite(body: SkillSiteAddInput) {
    return readRpcJson(rpcClient.api.skills.sites.$post({ json: body }));
  },

  patchSite(id: string, patch: SkillSitePatchInput) {
    return readRpcJson(rpcClient.api.skills.sites[':id'].$patch({
      json: patch,
      param: { id },
    }));
  },

  removeSite(id: string) {
    return readRpcJson(rpcClient.api.skills.sites[':id'].$delete({ param: { id } }));
  },

  /** POST /api/skills/sites/refresh — 全站刷新（各站成败独立报告）。 */
  refreshSites(): Promise<SkillSitesRefreshResult> {
    return readRpcJson(rpcClient.api.skills.sites.refresh.$post());
  },

  /** POST /api/skills/sites/install — 以站点缓存索引条目安装。 */
  installFromSite(body: SkillInstallInput): Promise<SkillInstallResult> {
    return readRpcJson(rpcClient.api.skills.sites.install.$post({ json: body }));
  },
};
