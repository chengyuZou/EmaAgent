// HTTP 路由总装：唯一挂载表。文件夹按业务域划分，挂载前缀即 URL；
// Route 只做传输解析与协议转换，业务入口全部来自 Composition，这里不构造业务对象。
// 顶层必须整链（.use/.route/.notFound/.onError 同链）：语句式 app.route(...) 会丢类型账本，
// ReturnType<typeof createRoutes>（AppType）将退化为裸 Hono，Hono RPC 契约直接失效。
import {
  ATTACHMENT_RESIDUE_MAX_AGE_MS,
  readAttachmentCacheSettings,
} from '@ema-agent/attachments';
import { Hono } from 'hono';
import { deleteSession } from '../application/deleteSession.js';
import {
  activateCharacter,
  deleteCharacter,
  runWhenSessionsIdle,
} from '../application/changeCharacter.js';
import type { Composition } from '../composition/index.js';
import { emaAuth, localWebviewCors } from '../platform/auth.js';
import { requestBudgetMiddleware } from '../platform/requestBudget.js';
import { subagentListRoute } from './subagents/list.js';
import { subagentMessagesRoute } from './subagents/messages.js';
import { backgroundProcessControlRoute } from './backgroundProcesses/control.js';
import { backgroundProcessListRoute } from './backgroundProcesses/list.js';
import { sessionBackupRoute } from './backup/sessions.js';
import { characterCollectionRoute } from './characters/collection.js';
import { characterPresentationRoute } from './characters/presentation.js';
import { characterResourcesRoute } from './characters/resources.js';
import { commandsCatalogRoute } from './commands/catalog.js';
import { sessionWebSocketRoute } from './ws/session.js';
import { speechWebSocketRoute } from './ws/speech.js';
import { knowledgeDocumentsRoute } from './knowledge/documents.js';
import { knowledgeIngestRoute } from './knowledge/ingest.js';
import { knowledgeLibsRoute } from './knowledge/libs.js';
import { knowledgeReembedRoute } from './knowledge/reembed.js';
import { knowledgeSearchRoute } from './knowledge/search.js';
import { mcpMarketRoute } from './mcp/market.js';
import { mcpEnvironmentRoute } from './mcp/environment.js';
import { mcpServersRoute } from './mcp/servers.js';
import { memoryFilesRoute } from './memory/files.js';
import { memoryJobsRoute } from './memory/jobs.js';
import { memoryStatsRoute } from './memory/stats.js';
import { narrativeControlRoute } from './narrative/control.js';
import { providerCapabilitiesRoute } from './providers/capabilities.js';
import { providerConfigsRoute } from './providers/configs.js';
import { providerHealthRoute } from './providers/health.js';
import { providerModelsRoute } from './providers/models.js';
import { sessionActionsRoute } from './sessions/actions.js';
import { sessionAttachmentsRoute } from './sessions/attachments.js';
import { sessionCollectionRoute } from './sessions/collection.js';
import { sessionHistoryRoute } from './sessions/history.js';
import { sessionGitRoute } from './sessions/git.js';
import { settingsEventDisplayRoute } from './settings/eventDisplay.js';
import { settingsValuesRoute } from './settings/values.js';
import { skillListRoute } from './skills/list.js';
import { skillMarketRoute } from './skills/market.js';
import { systemStatsRoute } from './system/stats.js';
import { usageRecordsRoute } from './system/usageRecords.js';
import { systemStatusRoute } from './system/status.js';
import { systemEventsRoute } from './system/events.js';
import { tasksRoute } from './tasks.js';
import { turnAudioRoute } from './turns/audio.js';
import { turnControlRoute } from './turns/control.js';
import { filesRoute } from './workspaces/files.js';
import { projectsRoute } from './workspaces/projects.js';

export const createRoutes = (composition: Composition, secret: string) => {
  const {
    database, settings, providers, tools, knowledge,
    characters, speech, turn, commands, memory, backup,
    sessionConnections, appEvents, turnFanout,
  } = composition;
  const characterChangeDeps = {
    characters: characters.store,
    sessionRunning: database.sessionRunning,
  };

  // CORS 必须先处理不携带业务密钥的 OPTIONS 预检，真正请求再进入认证和预算。
  return new Hono()
    .use('*', localWebviewCors())
    .use('*', emaAuth(secret))
    .use('*', requestBudgetMiddleware())

    // 探活挂在根路径 /health; 宿主也可用它检查已公布端口, emaAuth 内豁免认证.
    .route('/', systemStatusRoute({
      activeDataDir: database.activeDataDir,
      getSandboxStatus: tools.getSandboxStatus,
    }))
    .route('/api/system', systemEventsRoute(appEvents))
    .route('/api/system', systemStatsRoute({
      dataDirStats: database.dataDirStats,
      sessionStats: database.sessionStats,
      messages: database.messages,
    }))
    .route('/api/system', usageRecordsRoute({
      usageRecords: database.usageRecords,
    }))

    .route('/api/ws/session', sessionWebSocketRoute({
      connections: sessionConnections,
      executor: turn.turnExecutor,
      subagents: turn.subagents,
      continuations: turn.continuations,
      sessions: database.session,
      turns: database.turns,
      sessionRunning: database.sessionRunning,
      interactions: turn.interactionQueue,
      compactSession: commands.compactSession,
      attachTurn: (handle, ttsEnabled) => turnFanout.attach(handle, { ttsEnabled }),
    }))
    .route('/', narrativeControlRoute(composition.narrative))
    .route('/api/ws/speech', speechWebSocketRoute(speech))
    .route('/api/turns', turnControlRoute({
      turns: database.turns,
      toolExecutionState: tools.toolExecutionState,
    }))
    .route('/api/turns', turnAudioRoute({
      audioArchive: speech.audioArchive,
      turns: database.turns,
    }))

    .route('/api/sessions', sessionCollectionRoute({ session: database.session }))
    .route('/api/sessions', sessionActionsRoute({
      session: database.session,
      turns: database.turns,
      abortSubagentsForTurn: turnId => turn.subagents.abortForTurn(turnId),
      // 跨域删除用例在 application 层，装配时绑定 composition。
      deleteSession: sessionId => deleteSession(composition, sessionId),
    }))
    .route('/api/sessions', sessionHistoryRoute({
      session: database.session,
      turns: database.turns,
      usageRecords: database.usageRecords,
      audioArchive: speech.audioArchive,
      providerModels: providers.providerModels,
      onSessionOpened: sessionId => {
        // 附件残留清扫(贴了没发/无行残渣)与 vision 描述缓存驱逐,fire-and-forget。
        void database.attachments
          .sweep(sessionId, ATTACHMENT_RESIDUE_MAX_AGE_MS)
          .catch(error => console.warn('[attachments] 残留清扫失败:', error));
        void turn.visionCache.sweepIfIdle({
          isIdle: () => database.sessionRunning.runningSessionCount() === 0,
          maxBytesForSweep: () => readAttachmentCacheSettings(settings.settings).maxBytes,
        }).catch(error => console.warn('[attachments] vision 缓存清扫失败:', error));
      },
    }))
    .route('/api/sessions', sessionGitRoute(database.session))
    .route('/api/sessions', sessionAttachmentsRoute({
      sessions: database.session,
      attachmentImages: database.attachmentImages,
      attachmentPastedTexts: database.attachmentPastedTexts,
      imageStore: database.imageStore,
      pasteStore: database.pasteStore,
      activeDataDir: database.activeDataDir,
    }))
    // backup 是独立业务域（未来还有角色/设置备份）；Session 支路的 URL 仍在 /api/sessions 下。
    .route('/api/sessions', sessionBackupRoute({
      backup: backup.sessionBackup,
      onImported: () => appEvents.emit({ type: 'session_list_changed' }),
    }))
    .route('/api/commands', commandsCatalogRoute({
      listCommandDescriptors: commands.listCommandDescriptors,
    }))

    .route('/api/tasks', tasksRoute(database.tasks))

    .route('/api/subagents', subagentListRoute({ subagents: database.subagents }))
    .route('/api/subagents', subagentMessagesRoute({
      subagents: database.subagents,
      subagentMessages: database.subagentMessages,
    }))

    .route('/api/background-processes', backgroundProcessListRoute({
      backgroundProcesses: tools.backgroundProcesses,
    }))
    .route('/api/background-processes', backgroundProcessControlRoute({
      backgroundProcesses: tools.backgroundProcesses,
    }))

    .route('/api/kb', knowledgeLibsRoute({
      kb: knowledge.kb,
      providerModels: providers.providerModels,
      emit: event => appEvents.emit(event),
    }))
    .route('/api/kb', knowledgeIngestRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeReembedRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeSearchRoute({ kb: knowledge.kb }))
    .route('/api/kb', knowledgeDocumentsRoute({ kb: knowledge.kb, emit: event => appEvents.emit(event) }))

    .route('/api/mcp', mcpServersRoute({ mcp: tools.mcp }))
    .route('/api/mcp', mcpEnvironmentRoute({
      environment: tools.mcpEnvironment,
    }))
    .route('/api/mcp', mcpMarketRoute({ market: tools.mcpMarket }))

    // 静态 /bindings、/available 路由必须先于 configs 的 /:providerId，避免被当作 Provider id。
    .route('/api/providers', providerModelsRoute({
      providers: providers.providers,
      providerModels: providers.providerModels,
      modelBindings: providers.modelBindings,
      refreshCatalog: providers.refreshCatalog,
      notifyProviderModelsChanged: providerId => appEvents.emit({ type: 'provider_models_changed', providerId }),
      notifyModelBindingsChanged: () => appEvents.emit({ type: 'model_bindings_changed' }),
    }))
    .route('/api/providers', providerConfigsRoute({
      providers: providers.providers,
      providerModels: providers.providerModels,
      refreshCatalog: providers.refreshCatalog,
      notifyProviderConfigChanged: () => appEvents.emit({ type: 'provider_config_changed' }),
      notifyProviderModelsChanged: providerId => appEvents.emit({ type: 'provider_models_changed', providerId }),
    }))
    .route('/api/providers', providerHealthRoute({
      providers: providers.providers,
      providerModels: providers.providerModels,
      modelCatalog: providers.modelCatalog,
      notifyProviderHealthChanged: providerId => appEvents.emit({ type: 'provider_health_changed', providerId }),
    }))
    .route('/api/providers', providerCapabilitiesRoute({
      voicePreview: speech.voicePreview,
      transcribe: speech.transcribe,
      sttPreview: speech.sttPreview,
    }))

    .route('/api/settings', settingsEventDisplayRoute({ settings: settings.settings }))
    .route('/api/settings', settingsValuesRoute({ settings: settings.settings }))

    .route('/api/skills', skillListRoute({
      skills: tools.skills,
      skillStore: tools.skillStore,
      skillEnablement: tools.skillEnablement,
      settings: settings.settings,
      sessions: database.session,
      emitApp: event => appEvents.emit(event),
    }))
    .route('/api/skills', skillMarketRoute({
      market: tools.skillMarket,
      installer: tools.skillMarketInstaller,
      skills: tools.skills,
      emitApp: event => appEvents.emit(event),
    }))

    .route('/api/characters', characterCollectionRoute({
      characters: characters.store,
      activateCharacter: characterName => activateCharacter(characterChangeDeps, characterName),
      deleteCharacter: characterName => deleteCharacter(characterChangeDeps, characterName),
      runWhenSessionsIdle: action => runWhenSessionsIdle(characterChangeDeps, action),
    }))
    .route('/api/characters', characterResourcesRoute({
      characters: characters.store,
      runWhenSessionsIdle: action => runWhenSessionsIdle(characterChangeDeps, action),
    }))
    .route('/api/characters', characterPresentationRoute({ characters: characters.store }))

    .route('/api/memory', memoryJobsRoute({ jobs: memory.jobs }))
    .route('/api/memory', memoryFilesRoute({ memoryRoot: memory.memoryRoot }))
    .route('/api/memory', memoryStatsRoute({
      memoryRoot: memory.memoryRoot,
    }))

    .route('/api/workspaces', projectsRoute({ session: database.session }))
    .route('/api/workspaces', filesRoute())

    .notFound(context => context.json({ error: 'not_found' }, 404))
    .onError((error, context) => {
      console.warn('[http] 未捕获错误:', error);
      return context.json({ error: 'internal_error' }, 500);
    });
};

/** 路由定义即契约：desktop 经 `hc<AppType>` 获得路径/请求/响应全类型；纯类型零运行时。 */
export type AppType = ReturnType<typeof createRoutes>;
