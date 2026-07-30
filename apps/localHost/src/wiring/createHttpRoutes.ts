// 在 LocalHost 组合根中构造并排序所有 HTTP 业务路由。

import { createSkillsRouter } from '../routes/skills.js';
import { createMcpRouter } from '../routes/mcp.js';
import { createMarketRouter } from '../routes/market.js';
import { healthRoute } from '../routes/health.js';
import { permissionRoute } from '../routes/permission.js';
import { memoryRoute } from '../routes/memory.js';
import { systemEventsRoute } from '../routes/system-events.js';
import { settingsRoute } from '../routes/settings.js';
import { transcribeRoute } from '../routes/transcribe.js';
import { cardsRoute } from '../routes/cards.js';
import { diagnosticRoute } from '../routes/diagnostic.js';
import { shellRoute } from '../routes/shell.js';
import { workspaceRoute } from '../routes/workspace.js';
import { kbRoute } from '../routes/knowledge-base.js';
import { agentRunsRoute } from '../routes/agentRuns.js';
import { tasksRoute } from '../routes/tasks.js';
import { storageStatsRoute } from '../routes/storage-stats.js';
import { systemRoute } from '../routes/system.js';
import { backgroundProcessesRoute } from '../routes/backgroundProcesses.js';
import { createSettingsCatalog } from '../settings/createSettingsCatalog.js';
import type { MountedHttpRoute } from '../server.js';
import type { AppBindings } from './bindings.js';
import { createTurnsRouter } from './createTurnsRouter.js';
import { createSessionsRouter } from './createSessionsRouter.js';
import { createProvidersRouter } from './createProvidersRouter.js';
import { createModelBindingsRouter } from './createModelBindingsRouter.js';

/**
 * Router 在 Composition Root 取得各自的窄依赖；返回值只描述 URL 与 Hono Router，
 * 因此 HTTP Server 不需要知道 Session、Provider、Agent 或 Storage 的对象图。
 */
export function createHttpRoutes(bindings: AppBindings): readonly MountedHttpRoute[] {
  return [
    { path: '/health', router: healthRoute() },
    { path: '/api/turns', router: createTurnsRouter(bindings) },
    { path: '/api/providers', router: createProvidersRouter(bindings) },
    { path: '/api/model-bindings', router: createModelBindingsRouter(bindings) },
    {
      path: '/api/storage',
      router: storageStatsRoute({
        activeDataDir: bindings.activeDataDir,
        dataDb: bindings.dataDb,
        storageStats: bindings.storageStats,
        sessionStats: bindings.sessionStats,
        sessionNotes: bindings.sessionNotes,
        sessionBackup: bindings.sessionBackup,
        session: bindings.session,
      }),
    },
    { path: '/api/sessions', router: createSessionsRouter(bindings) },
    {
      path: '/api/permission',
      router: permissionRoute(bindings.permission, bindings.interactionQueue),
    },
    {
      path: '/api/memory',
      router: memoryRoute(bindings.memory, bindings.memoryBackgroundHealth),
    },
    { path: '/api/system/events', router: systemEventsRoute(bindings.systemBus) },
    {
      path: '/api/system',
      router: systemRoute(bindings.activeDataDir, bindings.sandboxStatus),
    },
    { path: '/api/system/shell', router: shellRoute(bindings.permission) },
    { path: '/api/workspace', router: workspaceRoute() },
    {
      path: '/api/settings',
      router: settingsRoute({
        settings: bindings.settings,
        catalog: createSettingsCatalog(),
        setDefaultPermissionTimeout: timeoutMs => {
          bindings.interactionQueue.setDefaultTimeout(timeoutMs);
        },
      }),
    },
    { path: '/api/diagnostics', router: diagnosticRoute() },
    {
      path: '/api/transcribe',
      router: transcribeRoute(bindings.stt, bindings.modelBindings),
    },
    { path: '/api/cards', router: cardsRoute(bindings.card) },
    {
      path: '/api',
      router: createSkillsRouter(
        bindings.skillStore,
        bindings.skillInstaller,
        bindings.marketSourceStore,
        bindings.marketRegistry,
      ),
    },
    {
      path: '/api/mcp',
      router: createMcpRouter(
        bindings.mcpRegistry,
        bindings.marketSourceStore,
        bindings.marketRegistry,
      ),
    },
    {
      path: '/api/market',
      router: createMarketRouter(bindings.marketSourceStore, bindings.marketRegistry),
    },
    {
      path: '/api/kb',
      router: kbRoute({
        kb: bindings.kb,
        settings: bindings.settings,
        modelBindings: bindings.modelBindings,
        providerEmbedModels: bindings.providerEmbedModels,
        embed: bindings.embed,
      }),
    },
    {
      path: '/api/agent-runs',
      router: agentRunsRoute(bindings.agentRunStore, bindings.agentRunTranscript),
    },
    { path: '/api/tasks', router: tasksRoute(bindings.taskStore) },
    {
      path: '/api/background-processes',
      router: backgroundProcessesRoute(bindings.backgroundProcesses),
    },
  ];
}
