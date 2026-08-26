// Workspaces API：/api/workspaces——项目态（projects）、数据目录注册表（data-dirs）
// 与本机文件浏览/预览（files）。三个域三个对象，无旧前缀兼容映射。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

// ── Projects ─────────────────────────────────────────────────────────────────

export type ProjectCreateInput = InferRequestType<RpcClient['api']['workspaces']['projects']['$post']>['json'];
export type ProjectRecord = RpcJson<RpcClient['api']['workspaces']['projects']['$post']>;
export type ProjectAssignInput = InferRequestType<RpcClient['api']['workspaces']['projects'][':id']['sessions']['$post']>['json'];

export const projectsApi = {
  create(body: ProjectCreateInput): Promise<ProjectRecord> {
    return readRpcJson(rpcClient.api.workspaces.projects.$post({ json: body }));
  },

  patch(id: string, name: string) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].$patch({
      json: { name },
      param: { id },
    }));
  },

  remove(id: string) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].$delete({ param: { id } }));
  },

  pin(id: string, pinned: boolean) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].pin.$post({
      json: { pinned },
      param: { id },
    }));
  },

  addFolder(id: string, path: string) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].folders.$post({
      json: { path },
      param: { id },
    }));
  },

  removeFolder(id: string, path: string) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].folders.$delete({
      json: { path },
      param: { id },
    }));
  },

  setPrimaryFolder(id: string, path: string) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id']['primary-folder'].$put({
      json: { path },
      param: { id },
    }));
  },

  /** 把 Session 挂进项目：workspace_root 立即改写为项目主工作区并锁定。 */
  addSession(id: string, body: ProjectAssignInput) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].sessions.$post({
      json: body,
      param: { id },
    }));
  },

  removeSession(id: string, sessionId: string) {
    return readRpcJson(rpcClient.api.workspaces.projects[':id'].sessions[':sessionId'].$delete({
      param: { id, sessionId },
    }));
  },
};

// ── Data dirs ────────────────────────────────────────────────────────────────

export type DataDirRegistry = RpcJson<RpcClient['api']['workspaces']['data-dirs']['$get']>;
export type DataDirItem = DataDirRegistry['dirs'][number];
export type DataDirAddInput = InferRequestType<RpcClient['api']['workspaces']['data-dirs']['$post']>['json'];
export type DataDirMigrateInput = InferRequestType<RpcClient['api']['workspaces']['data-dirs']['migrate']['$post']>['json'];

export const dataDirsApi = {
  listDirs(): Promise<DataDirRegistry> {
    return readRpcJson(rpcClient.api.workspaces['data-dirs'].$get());
  },

  addDir(body: DataDirAddInput) {
    return readRpcJson(rpcClient.api.workspaces['data-dirs'].$post({ json: body }));
  },

  removeDir(name: string) {
    return readRpcJson(rpcClient.api.workspaces['data-dirs'][':name'].$delete({ param: { name } }));
  },

  /** 写入新活动项即完成；当前进程仍连旧目录，必须重启生效。 */
  activateDir(name: string) {
    return readRpcJson(rpcClient.api.workspaces['data-dirs'][':name'].activate.$post({
      param: { name },
    }));
  },

  /** 迁移：热拷贝 data.db + 文件目录复制，注册并切换后要求重启。 */
  migrate(body: DataDirMigrateInput) {
    return readRpcJson(rpcClient.api.workspaces['data-dirs'].migrate.$post({ json: body }));
  },
};

// ── Files（前端 Files 面板的本机文件浏览） ────────────────────────────────────

export type FileListResult = RpcJson<RpcClient['api']['workspaces']['files']['ls']['$get']>;
export type FileEntry = FileListResult['entries'][number];
export type FileContent = RpcJson<RpcClient['api']['workspaces']['files']['file']['$get']>;

export const filesApi = {
  /** GET /api/workspaces/files/ls?path= — 目录列表（目录在前，组内按名称）。 */
  ls(dirPath: string): Promise<FileListResult> {
    return readRpcJson(rpcClient.api.workspaces.files.ls.$get({ query: { path: dirPath } }));
  },

  /** GET /api/workspaces/files/file?path= — 有界预览（文本/图片/过大/二进制四态）。 */
  readFile(filePath: string): Promise<FileContent> {
    return readRpcJson(rpcClient.api.workspaces.files.file.$get({ query: { path: filePath } }));
  },
};
