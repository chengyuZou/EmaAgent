import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, serverClient, type RpcClient, type RpcJson } from './client.js';


export type ProjectCreateInput = InferRequestType<RpcClient['api']['workspaces']['projects']['$post']>['json'];
export type ProjectAssignInput = InferRequestType<RpcClient['api']['workspaces']['projects'][':id']['sessions']['$post']>['json'];
export type SessionSidebarMoveInput = InferRequestType<RpcClient['api']['workspaces']['sidebar']['sessions'][':sessionId']['$put']>['json'];
export type ProjectSidebarMoveInput = InferRequestType<RpcClient['api']['workspaces']['sidebar']['projects'][':projectId']['$put']>['json'];

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

  /** 把已有 Session 挂进项目; 会话 cwd 保持原值. */
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

export const sidebarApi = {
  moveSession(sessionId: string, body: SessionSidebarMoveInput) {
    return readRpcJson(rpcClient.api.workspaces.sidebar.sessions[':sessionId'].$put({
      json: body,
      param: { sessionId },
    }));
  },

  moveProject(projectId: string, body: ProjectSidebarMoveInput) {
    return readRpcJson(rpcClient.api.workspaces.sidebar.projects[':projectId'].$put({
      json: body,
      param: { projectId },
    }));
  },
};



export type FileListResult = RpcJson<RpcClient['api']['workspaces']['files']['ls']['$get']>;
export type FileContent = RpcJson<RpcClient['api']['workspaces']['files']['file']['$get']>;

export const filesApi = {
  /** GET /api/workspaces/files/ls?path=  -  目录列表(目录在前, 组内按名称). */
  ls(dirPath: string, signal?: AbortSignal): Promise<FileListResult> {
    return readRpcJson(rpcClient.api.workspaces.files.ls.$get(
      { query: { path: dirPath } },
      { init: { signal } },
    ));
  },

  /** GET /api/workspaces/files/file?path=  -  有界预览(文本/图片/过大/二进制四态). */
  readFile(filePath: string): Promise<FileContent> {
    return readRpcJson(rpcClient.api.workspaces.files.file.$get({ query: { path: filePath } }));
  },

  /** 只生成原生 audio 可请求的本机地址, 不读取文件或把音频转成 Blob. */
  audioUrl(filePath: string): Promise<string> {
    const query = new URLSearchParams({ path: filePath });
    return serverClient.audioUrl(`/api/workspaces/files/audio?${query}`);
  },
};
