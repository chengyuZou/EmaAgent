// Narrative 的运行中关闭请求经 TS Server 发给 Python Bridge.
import { rpcClient, readRpcJson } from './client.js';

export const narrativeApi = {
  shutdown(): Promise<{ status: 'shutting_down' }> {
    return readRpcJson(rpcClient.api.narrative.shutdown.$post());
  },
};
