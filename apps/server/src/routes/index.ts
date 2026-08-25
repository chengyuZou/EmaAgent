// HTTP 路由总装：唯一挂载表。文件夹按业务域划分，挂载前缀即 URL；
// Route 只做 Wire 解析与协议转换，业务入口全部来自 Composition，这里不构造业务对象。
// 顶层必须整链（.use/.route/.notFound/.onError 同链）：语句式 app.route(...) 会丢类型账本，
// ReturnType<typeof createRoutes>（AppType）将退化为裸 Hono，Hono RPC 契约直接失效。
import { Hono } from 'hono';
import { deleteSession } from '../application/deleteSession.js';
import type { Composition } from '../composition/index.js';
import { emaAuth } from '../platform/auth.js';
import { requestBudgetMiddleware } from '../platform/requestBudget.js';
import { agentRunListRoute } from './agentRuns/list.js';
import { agentRunTranscriptRoute } from './agentRuns/transcript.js';
import { backgroundProcessControlRoute } from './backgroundProcesses/control.js';
import { backgroundProcessListRoute } from './backgroundProcesses/list.js';
import { sessionBackupRoute } from './backup/sessions.js';
import { characterCollectionRoute } from './characters/collection.js';
import { characterHealthRoute } from './characters/health.js';
import { characterResourcesRoute } from './characters/resources.js';
import { commandsCatalogRoute } from './commands/catalog.js';
import { commandsCompactRoute } from './commands/compact.js';
import { knowledgeDocumentsRoute } from './knowledge/documents.js';
import { knowledgeIngestRoute } from './knowledge/ingest.js';
import { knowledgeLibsRoute } from './knowledge/libs.js';
import { knowledgeReembedRoute } from './knowledge/reembed.js';
import { knowledgeSearchRoute } from './knowledge/search.js';
import { mcpRegistryRoute } from './mcp/registry.js';
import { mcpServersRoute } from './mcp/servers.js';
import { memoryFilesRoute } from './memory/files.js';
import { memoryJobsRoute } from './memory/jobs.js';
import { memoryOpsRoute } from './memory/ops.js';
import { memoryStatsRoute } from './memory/stats.js';
import { providerCapabilitiesRoute } from './providers/capabilities.js';
import { providerConfigsRoute } from './providers/configs.js';
import { providerHealthRoute } from './providers/health.js';
import { providerKeysRoute } from './providers/keys.js';
import { providerModelsRoute } from './providers/models.js';
import { sessionActionsRoute } from './sessions/actions.js';
import { sessionAttachmentsRoute } from './sessions/attachments.js';
import { sessionCollectionRoute } from './sessions/collection.js';
import { sessionHistoryRoute } from './sessions/history.js';
import { settingsCatalogRoute } from './settings/catalog.js';
import { settingsValuesRoute } from './settings/values.js';
import { skillListRoute } from './skills/list.js';
import { skillSitesRoute } from './skills/sites.js';
import { systemEventsRoute } from './system/events.js';
import { systemStatsRoute } from './system/stats.js';
import { systemStatusRoute } from './system/status.js';
import { tasksRoute } from './tasks.js';
import { turnAudioRoute } from './turns/audio.js';
import { turnControlRoute } from './turns/control.js';
import { turnEventsRoute } from './turns/events.js';
import { turnInteractionsRoute } from './turns/interactions.js';
import { startTurnRoute } from './turns/startTurn.js';
import { dataDirsRoute } from './workspaces/dataDirs.js';
import { filesRoute } from './workspaces/files.js';
import { projectsRoute } from './workspaces/projects.js';

export const createRoutes = (composition: Composition, secret: string) => {
  const {
    database, settings, providers, tools, knowledge,
    characters, speech, turn, commands, memory, backup,
    eventHub, turnEvents, turnFanout,
  } = composition;

  // 先认证后预算：未授权请求连体积拒绝响应都不必给。
  return new Hono()
    .use('*', emaAuth(secret))
    .use('*', requestBudgetMiddleware())

    // 探活挂在根路径 /health：宿主在 ready 文件发布前轮询，emaAuth 内豁免认证。
    .route('/', systemStatusRoute({
      activeDataDir: database.activeDataDir,
      sandboxStatus: tools.sandboxStatus,
    }))
    .route('/api/system', systemEventsRoute({ hub: eventHub }))
    .route('/api/system', systemStatsRoute({
      dataDirStats: database.dataDirStats,
      sessionStats: database.sessionStats,
    }))

    .route('/api/turns', startTurnRoute({
      executor: turn.turnExecutor,
      fanout: turnFanout,
      session: database.session,
    }))
    .route('/api/turns', turnEventsRoute({ hub: eventHub, store: turnEvents }))
    .route('/api/turns', turnControlRoute({
      executor: turn.turnExecutor,
      turns: database.turns,
      toolExecutionState: tools.toolExecutionState,
    }))
    .route('/api/turns', turnAudioRoute({
      audioArchive: speech.audioArchive,
      turns: database.turns,
    }))
    .route('/api/turns', turnInteractionsRoute({ queue: turn.interactionQueue }))

    .route('/api/sessions', sessionCollectionRoute({ session: database.session }))
    .route('/api/sessions', sessionActionsRoute({
      session: database.session,
      turns: database.turns,
      activeSessions: database.activeSessions,
      invalidateSessionRunner: sessionId => tools.invalidateSessionRunner(sessionId),
      // 跨域删除用例在 application 层，装配时绑定 composition。
      deleteSession: sessionId => deleteSession(composition, sessionId),
    }))
    .route('/api/sessions', sessionHistoryRoute({
      session: database.session,
      turns: database.turns,
      attachments: database.attachments,
    }))
    .route('/api/sessions', sessionAttachmentsRoute({
      attachments: database.attachments,
      turns: database.turns,
    }))
    // backup 是独立业务域（未来还有角色/设置备份）；Session 支路的 URL 仍在 /api/sessions 下。
    .route('/api/sessions', sessionBackupRoute({ backup: backup.sessionBackup }))
    // /compact 是 Session 级确定性命令，不创建 Turn；URL 挂在 /api/sessions 下。
    .route('/api/sessions', commandsCompactRoute({
      compactSession: commands.compactSession,
    }))
    .route('/api/commands', commandsCatalogRoute({
      listCommandDescriptors: commands.listCommandDescriptors,
    }))

    .route('/api/tasks', tasksRoute(database.tasks))

    .route('/api/agent-runs', agentRunListRoute({ agentRuns: database.agentRuns }))
    .route('/api/agent-runs', agentRunTranscriptRoute({
      agentRuns: database.agentRuns,
      agentRunMessages: database.agentRunMessages,
    }))

    .route('/api/background-processes', backgroundProcessListRoute({
      backgroundProcesses: tools.backgroundProcesses,
    }))
    .route('/api/background-processes', backgroundProcessControlRoute({
      backgroundProcesses: tools.backgroundProcesses,
    }))

    .route('/api/kb', knowledgeLibsRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeIngestRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeReembedRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeSearchRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeDocumentsRoute({ kb: knowledge.kb }))

    .route('/api/mcp', mcpServersRoute({ mcp: tools.mcp, mcpSources: tools.mcpSources }))
    .route('/api/mcp', mcpRegistryRoute({
      mcp: tools.mcp,
      mcpSources: tools.mcpSources,
      stdioApprovals: tools.stdioApprovals,
    }))

    .route('/api/providers', providerConfigsRoute({ providers: providers.providers }))
    .route('/api/providers', providerKeysRoute({ providers: providers.providers }))
    .route('/api/providers', providerModelsRoute({
      providers: providers.providers,
      providerModels: providers.providerModels,
      modelBindings: providers.modelBindings,
      onKbEmbeddingBindingChanged: knowledge.onKbEmbeddingBindingChanged,
    }))
    .route('/api/providers', providerHealthRoute({
      providers: providers.providers,
      providerModels: providers.providerModels,
    }))
    .route('/api/providers', providerCapabilitiesRoute({
      voicePreview: speech.voicePreview,
      transcribe: speech.transcribe,
    }))

    .route('/api/settings', settingsCatalogRoute({ settings: settings.settings }))
    .route('/api/settings', settingsValuesRoute({ settings: settings.settings }))

    .route('/api/skills', skillListRoute({
      skills: tools.skills,
      skillStore: tools.skillStore,
      settings: settings.settings,
      sessions: database.session,
    }))
    .route('/api/skills', skillSitesRoute({
      skillSites: tools.skillSites,
      skillStore: tools.skillStore,
      skills: tools.skills,
      skillUserRoot: tools.skillUserRoot,
    }))

    .route('/api/characters', characterCollectionRoute({ characters: characters.store }))
    .route('/api/characters', characterResourcesRoute({ characters: characters.store }))
    .route('/api/characters', characterHealthRoute({ characters: characters.store }))

    .route('/api/memory', memoryJobsRoute({ jobs: memory.jobs, admin: memory.admin }))
    .route('/api/memory', memoryFilesRoute({ memoryRoot: memory.memoryRoot }))
    .route('/api/memory', memoryStatsRoute({
      memoryRoot: memory.memoryRoot,
      settings: settings.settings,
    }))
    .route('/api/memory', memoryOpsRoute({
      startConsolidation: memory.startConsolidation,
      startMaintenance: memory.startMaintenance,
    }))

    .route('/api/workspaces', projectsRoute({ session: database.session }))
    .route('/api/workspaces', dataDirsRoute({
      activeDataDir: database.activeDataDir,
      dataDb: database.dataDb,
    }))
    .route('/api/workspaces', filesRoute())

    .notFound(context => context.json({ error: 'not_found' }, 404))
    .onError((error, context) => {
      console.warn('[http] 未捕获错误:', error);
      return context.json({ error: 'internal_error' }, 500);
    });
};

/** 路由定义即契约：desktop 经 `hc<AppType>` 获得路径/请求/响应全类型；纯类型零运行时。 */
export type AppType = ReturnType<typeof createRoutes>;
