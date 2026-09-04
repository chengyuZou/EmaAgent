// Skills API：/api/skills——技能目录/详情/正文/启停/重扫/删除，以及技能市场（SkillHub/ClawHub 聚合）。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SkillListResult = RpcJson<RpcClient['api']['skills']['$get']>;
export type SkillListItem = SkillListResult['items'][number];
export type SkillDescriptorResult = RpcJson<RpcClient['api']['skills']['descriptor']['$get']>;
export type SkillContentResult = RpcJson<RpcClient['api']['skills']['content']['$get']>;
export type SkillProjectSourceList = RpcJson<RpcClient['api']['skills']['sources']['$get']>;
export type SkillFileListResult = RpcJson<RpcClient['api']['skills']['files']['$get']>;
export type SkillFileContentResult = RpcJson<RpcClient['api']['skills']['file']['$get']>;

export type SkillMarketList = RpcJson<RpcClient['api']['skills']['market']['skills']['$get']>;
export type SkillMarketItem = SkillMarketList['items'][number];
export type SkillMarketSourcesStatus = SkillMarketList['sources'];
export type SkillMarketDetailResult = RpcJson<RpcClient['api']['skills']['market']['skills'][':source'][':slug']['$get']>;
export type SkillMarketFileContentResult = RpcJson<RpcClient['api']['skills']['market']['skills'][':source'][':slug']['file']['$get']>;
export type SkillMarketInstallBody = InferRequestType<RpcClient['api']['skills']['market']['install']['$post']>['json'];

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

  /** GET /api/skills/descriptor?skillPath=&sessionId= — 单条详情。 */
  get(path: string, sessionId?: string): Promise<SkillDescriptorResult> {
    return readRpcJson(rpcClient.api.skills.descriptor.$get({
      query: { skillPath: path, ...withSessionId(sessionId) },
    }));
  },

  /** GET /api/skills/content?skillPath=&sessionId= — SKILL.md 正文。 */
  getContent(path: string, sessionId?: string): Promise<SkillContentResult> {
    return readRpcJson(rpcClient.api.skills.content.$get({
      query: { skillPath: path, ...withSessionId(sessionId) },
    }));
  },

  /** GET /api/skills/files?skillPath= — 技能目录文件清单(dotfiles 不进)。 */
  listFiles(path: string, sessionId?: string): Promise<SkillFileListResult> {
    return readRpcJson(rpcClient.api.skills.files.$get({
      query: { skillPath: path, ...withSessionId(sessionId) },
    }));
  },

  /** GET /api/skills/file?skillPath=&path= — 目录内文件预览(超限截断)。 */
  readFile(skillPath: string, path: string): Promise<SkillFileContentResult> {
    return readRpcJson(rpcClient.api.skills.file.$get({ query: { skillPath, path } }));
  },

  /** PUT /api/skills/enabled — builtin/user 逐技能启停（skill_enablement 表）。 */
  setEnabled(path: string, enabled: boolean): Promise<SkillDescriptorResult> {
    return readRpcJson(rpcClient.api.skills.enabled.$put({ json: { path, enabled } }));
  },

  /** POST /api/skills/rescan — 真实重扫 builtin+user 目录。 */
  rescan(sessionId?: string) {
    return readRpcJson(rpcClient.api.skills.rescan.$post({ query: withSessionId(sessionId) }));
  },

  /** DELETE /api/skills?skillPath=&sessionId= — 只有 user 技能可删。 */
  remove(path: string, sessionId?: string) {
    return readRpcJson(rpcClient.api.skills.$delete({
      query: { skillPath: path, ...withSessionId(sessionId) },
    }));
  },

  // ── 技能市场（/api/skills/market/*，SkillHub/ClawHub 聚合） ───────────────────

  /** GET /market/skills — 聚合两源;游标翻页。 */
  marketList(query: {
    q?: string;
    source?: 'all' | 'skillhub' | 'clawhub';
    installed?: 'all' | 'installed' | 'installable';
    cursor?: string;
    limit?: number;
  } = {}): Promise<SkillMarketList> {
    return readRpcJson(rpcClient.api.skills.market.skills.$get({
      query: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as never,
    }));
  },

  /** GET /market/skills/:source/:slug — 详情(含文件清单与安装状态)。 */
  marketDetail(source: string, slug: string): Promise<SkillMarketDetailResult> {
    return readRpcJson(rpcClient.api.skills.market.skills[':source'][':slug'].$get({
      param: { source, slug: encodeURIComponent(slug) },
    }));
  },

  /** GET .../file?path= — 文件全文预览(语法高亮语言 + 截断标记)。 */
  marketFileContent(source: string, slug: string, path: string): Promise<SkillMarketFileContentResult> {
    return readRpcJson(rpcClient.api.skills.market.skills[':source'][':slug'].file.$get({
      param: { source, slug: encodeURIComponent(slug) },
      query: { path },
    }));
  },

  /** POST /market/install — 逐文件下载校验后落位用户技能目录。 */
  marketInstall(body: SkillMarketInstallBody) {
    return readRpcJson(rpcClient.api.skills.market.install.$post({ json: body }));
  },

  /** POST /market/uninstall — 只删市场安装的目录(溯源标记验明)。 */
  marketUninstall(body: SkillMarketInstallBody) {
    return readRpcJson(rpcClient.api.skills.market.uninstall.$post({ json: body }));
  },
};
