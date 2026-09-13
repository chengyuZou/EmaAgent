// Workspaces API：/api/workspaces——项目态（projects）与本机文件浏览/预览（files）。
// 数据目录已单库化(~/.ema-agent/data 固定),不再有注册表面。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

// ── Projects ─────────────────────────────────────────────────────────────────

export type ProjectCreateInput = InferRequestType<RpcClient['api']['workspaces']['projects']['$post']>['json'];
export type ProjectAssignInput = InferRequestType<RpcClient['api']['workspaces']['projects'][':id']['sessions']['$post']>['json'];

export const projectsApi = {
  create(body: ProjectCreateInput) {
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
