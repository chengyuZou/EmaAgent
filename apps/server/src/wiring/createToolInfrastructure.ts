// 装配稳定的内置工具表、执行日志和按 Session 隔离的工具结果存储。

import path from 'node:path';
import { AgentRunStore, AgentRunTranscriptStore } from '@ema-agent/agent';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import type { SessionId } from '@ema-agent/ids';
import {
  AgentRunMessagesRepo,
  AgentRunsRepo,
  BackgroundProcessesRepo,
  TasksRepo,
  ToolExecutionsRepo,
  type Database,
} from '@ema-agent/storage';
import { TaskStore } from '@ema-agent/tasks';
import {
  BackgroundProcessRuntime,
  backgroundProcessSetting,
  ToolExecutionState,
  ToolRegistry,
  ToolResultCleaner,
  ToolResultStore,
} from '@ema-agent/tools';
import type { SettingsStore } from '@ema-agent/settings';
import type { BackgroundProcessEvent } from '@ema-agent/tools';
import { backgroundProcessOutputDirFor } from '../storage-locations/paths.js';

export function createToolInfrastructure(
  dataDb: Database,
  activeDataDir: string,
  disableExecuteTools: boolean,
  settings: SettingsStore,
  emit: (event: BackgroundProcessEvent) => void,
) {
  // 内置工具只注册一次并保持确定顺序；MCP 后续只能在同一 Registry 上增删自己的分区。
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, { disableExecuteTools });

  const sessionsDirectory = path.join(activeDataDir, 'sessions');
  const legacySessionsDirectory = path.join(
    activeDataDir,
    '.ema-agent',
    'sessions',
  );
  const resultStores = new Map<SessionId, ToolResultStore>();
  const getSessionToolResultStore = (sessionId: SessionId): ToolResultStore => {
    const cached = resultStores.get(sessionId);
    if (cached) return cached;

    const store = new ToolResultStore(
      path.join(sessionsDirectory, sessionId, 'tool-results'),
    );
    resultStores.set(sessionId, store);
    return store;
  };
  const backgroundProcesses = new BackgroundProcessRuntime({
    store: new BackgroundProcessesRepo(dataDb.sqlite),
    outputPath: (sessionId, processId) =>
      backgroundProcessOutputDirFor(activeDataDir, sessionId, processId),
    resolveOutputLocation: (relativeDirectory) => ({
      absoluteDirectory: path.join(activeDataDir, relativeDirectory),
      relativeDirectory,
    }),
    settings: () => settings.get(backgroundProcessSetting),
    emit,
  });

  return {
    tools,
    getSessionToolResultStore,
    /** Session 永久删除后不再让进程缓存持有对应结果存储。 */
    removeSessionToolState: (sessionId: SessionId): void => {
      resultStores.delete(sessionId);
    },
    toolResultCleaner: new ToolResultCleaner([
      sessionsDirectory,
      legacySessionsDirectory,
    ]),
    agentRunTranscript: new AgentRunTranscriptStore(
      new AgentRunMessagesRepo(dataDb.sqlite),
    ),
    agentRunStore: new AgentRunStore(new AgentRunsRepo(dataDb.sqlite)),
    taskStore: new TaskStore(new TasksRepo(dataDb.sqlite)),
    toolExecutionState: new ToolExecutionState(
      new ToolExecutionsRepo(dataDb.sqlite),
    ),
    backgroundProcesses,
  };
}
