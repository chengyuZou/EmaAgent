// System API：根路径探活与隔离状态 + /api/system 存储统计。
// SSE 事件流不进 hc 账本——走 lib/system-sse.ts 的流消费。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type HealthResult = RpcJson<RpcClient['health']['$get']>;
export type SandboxStatus = RpcJson<RpcClient['sandbox']['$get']>;
export type TerminalShellList = RpcJson<RpcClient['api']['system']['find-terminal-shells']['$get']>;
export type TerminalShellInfo = TerminalShellList['shells'][number];
export type DataDirStats = RpcJson<RpcClient['api']['system']['stats']['$get']>;
export type SessionStats = RpcJson<RpcClient['api']['system']['stats']['sessions'][':id']['$get']>;
export type SessionSummaries = RpcJson<RpcClient['api']['system']['stats']['session-summaries']['$get']>;
export type SessionSummary = SessionSummaries['sessions'][number];
export type RawMessagesPage = RpcJson<RpcClient['api']['system']['stats']['sessions'][':id']['raw-messages']['$get']>;
export type UsageRecordsPage = RpcJson<RpcClient['api']['system']['usage-records']['$get']>;

export const systemApi = {
  /** GET /health — 探活（认证豁免）。 */
  health(): Promise<HealthResult> {
    return readRpcJson(rpcClient.health.$get());
  },

  /** GET /sandbox — 当前机器真正启用的隔离等级（裸 Windows 如实降级）。 */
  getSandboxStatus(): Promise<SandboxStatus> {
    return readRpcJson(rpcClient.sandbox.$get());
  },

  /** GET /api/system/find-terminal-shells — 集成终端可选 Shell 探测（按 kind 优先级排序）。 */
  findTerminalShells(): Promise<TerminalShellList> {
    return readRpcJson(rpcClient.api.system['find-terminal-shells'].$get());
  },

  /** GET /api/system/stats — 数据目录聚合统计。 */
  getStats(): Promise<DataDirStats> {
    return readRpcJson(rpcClient.api.system.stats.$get());
  },

  /** GET /api/system/stats/session-summaries — 存储页 Session 手风琴的行投影。 */
  getSessionSummaries(): Promise<SessionSummaries> {
    return readRpcJson(rpcClient.api.system.stats['session-summaries'].$get());
  },

  /** GET /api/system/stats/sessions/:id/raw-messages — 原始消息(keyset 续翻+方向参数)。 */
  getRawMessages(sessionId: string, opts: { before?: { createdAt: number; id: string }; order?: 'asc' | 'desc'; limit?: number } = {}) {
    return readRpcJson(rpcClient.api.system.stats.sessions[':id']['raw-messages'].$get({
      param: { id: sessionId },
      query: {
        ...(opts.before ? {
          beforeCreatedAt: String(opts.before.createdAt),
          beforeId: opts.before.id,
        } : {}),
        order: opts.order ?? 'asc',
        limit: String(opts.limit ?? 50),
      },
    }));
  },

  /** GET /api/system/usage-records — 用量明细(Token 查看器)。 */
  getUsageRecords(opts: {
    sessionId?: string;
    capability?: 'llm' | 'vision' | 'embed' | 'rerank' | 'stt' | 'tts';
    before?: { createdAt: number; id: string };
    limit?: number;
  } = {}) {
    return readRpcJson(rpcClient.api.system['usage-records'].$get({
      query: {
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.capability ? { capability: opts.capability } : {}),
        ...(opts.before ? {
          beforeCreatedAt: String(opts.before.createdAt),
          beforeId: opts.before.id,
        } : {}),
        limit: String(opts.limit ?? 500),
      },
    }));
  },

  /** GET /api/system/stats/sessions/:id — 单 Session 统计。 */
  getSessionStats(id: string): Promise<SessionStats> {
    return readRpcJson(rpcClient.api.system.stats.sessions[':id'].$get({ param: { id } }));
  },
};
