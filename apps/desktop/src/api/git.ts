import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';
import type { GitDiffScope } from '@ema-agent/git';

export type { GitDiffScope } from '@ema-agent/git';

export type SessionGitSummary = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['summary']['$get']>;
export type SessionGitWorkspaceDiff = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['workspace-diff']['$get']>;
export type SessionGitRefs = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['refs']['$get']>;
export type SessionGitCompare = RpcJson<RpcClient['api']['sessions'][':sessionId']['git']['compare']['$post']>;
type CompareInput = InferRequestType<RpcClient['api']['sessions'][':sessionId']['git']['compare']['$post']>['json'];

export const sessionGitApi = {
  summary(sessionId: string): Promise<SessionGitSummary> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git.summary.$get({ param: { sessionId } }));
  },
  workspaceDiff(
    sessionId: string,
    scope: GitDiffScope,
    signal?: AbortSignal,
  ): Promise<SessionGitWorkspaceDiff> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git['workspace-diff'].$get(
      {
        param: { sessionId },
        query: { scope },
      },
      { init: { signal } },
    ));
  },
  refs(sessionId: string): Promise<SessionGitRefs> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git.refs.$get({ param: { sessionId } }));
  },
  compare(
    sessionId: string,
    target: CompareInput,
  ): Promise<SessionGitCompare> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].git.compare.$post({
      param: { sessionId },
      json: target,
    }));
  },
};
