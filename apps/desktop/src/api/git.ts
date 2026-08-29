// Session Git API：请求与响应全部从 Server 路由契约推导。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SessionGitSummary = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['summary']['$get']>;
export type SessionGitWorkspaceDiff = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['workspace-diff']['$get']>;
export type SessionGitRefs = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['refs']['$get']>;
export type SessionGitCompare = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['compare']['$post']>;

export const sessionGitApi = {
  summary(sessionId: string): Promise<SessionGitSummary> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git.summary.$get({ param: { sessionId } }));
  },
  workspaceDiff(sessionId: string): Promise<SessionGitWorkspaceDiff> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git['workspace-diff'].$get({ param: { sessionId } }));
  },
  refs(sessionId: string): Promise<SessionGitRefs> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git.refs.$get({ param: { sessionId } }));
  },
  compare(
    sessionId: string,
    target: { kind: 'branch'; branch: string } | { kind: 'commit'; sha: string },
  ): Promise<SessionGitCompare> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git.compare.$post({
      param: { sessionId },
      json: target,
    }));
  },
};
