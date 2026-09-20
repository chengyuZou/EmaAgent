// 唯一装配点：全部业务对象在此一次成型，族间依赖经 Composition 字段单向传递。
// routes/application/platform 只消费 Composition，不构造业务对象。
import { characterStageVocabulary } from '@ema-agent/characters';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import { AppEvents } from '../application/appEvents.js';
import { SessionSocketConnections } from '../routes/ws/session.js';
import { TurnFanout } from '../application/turnFanout.js';
import { openBackup, type BackupComposition } from './backup.js';
import { openCharacters, type CharactersComposition } from './characters.js';
import { openCommands, type CommandsComposition } from './commands.js';
import { openDatabases, type DatabaseComposition } from './database.js';
import { openKnowledge, type KnowledgeComposition } from './knowledge.js';
import { openMemory, type MemoryComposition } from './memory.js';
import { openNarrative, type NarrativeComposition } from './narrative.js';
import { openProviders, type ProvidersComposition } from './providers.js';
import { openSettings, type SettingsComposition } from './settings.js';
import { openSpeech, type SpeechComposition } from './speech.js';
import { openTools, type ToolsComposition } from './tools.js';
import { openTurns, type TurnComposition } from './turn.js';

export interface Composition {
  readonly database: DatabaseComposition;
  readonly settings: SettingsComposition;
  readonly providers: ProvidersComposition;
  readonly tools: ToolsComposition;
  readonly knowledge: KnowledgeComposition;
  readonly characters: CharactersComposition;
  readonly narrative: NarrativeComposition;
  readonly speech: SpeechComposition;
  readonly turn: TurnComposition;
  readonly commands: CommandsComposition;
  readonly memory: MemoryComposition;
  readonly backup: BackupComposition;
  readonly sessionConnections: SessionSocketConnections;
  readonly appEvents: AppEvents;
  readonly turnFanout: TurnFanout;
  /** 先停执行对象和后台工作, 最后关闭数据库. */
  close(): Promise<void>;
}

export function buildComposition(input: {
  activeDataDir: string;
  initializeBuiltinCharacters: boolean;
}): Composition {
  const appEvents = new AppEvents();
  const database = openDatabases(input.activeDataDir, event => appEvents.emit(event));
  const settings = openSettings(database.profileDb);
  const providers = openProviders(database.profileDb);
  const sessionConnections = new SessionSocketConnections();
  const stopPublishingActiveSessions = database.activeSessions.subscribe((sessionId, active) => {
    sessionConnections.publish(sessionId, { type: 'active_session_changed', active });
  });
  // Tools 在 Composition 返回前没有调用入口, 因此装配期间不可能产生真实完成通知.
  // 先放空出口打断构造顺序, openTurns 完成后再接到唯一 Session 队列.
  let notifyBackgroundCompletion = (
    _sessionId: string,
    _backgroundProcessId: string,
    _status: BackgroundProcessNotifiableStatus,
  ): void => undefined;
  const tools = openTools({
    profileDb: database.profileDb,
    dataDb: database.dataDb,
    activeDataDir: input.activeDataDir,
    settings: settings.settings,
    emitBackgroundEvent: event => appEvents.emit(event),
    onBackgroundCompletion: (sessionId, backgroundProcessId, status) => {
      notifyBackgroundCompletion(sessionId, backgroundProcessId, status);
    },
    emitMcpEvent: event => appEvents.emit(event),
  });
  const knowledge = openKnowledge(
    database.profileDb,
    providers.providers,
    providers.providerModels,
    providers.modelBindings,
    settings.settings,
    database.usageRecorder,
  );
  const characters = openCharacters(database.profileDb, input.initializeBuiltinCharacters);
  const narrative = openNarrative(providers.providers, providers.providerModels, providers.modelBindings);
  const speech = openSpeech(
    database.dataDb,
    input.activeDataDir,
    database.usageRecorder,
    providers.providers,
    providers.modelBindings,
    characters.store,
    event => appEvents.emit(event),
  );

  // ── 跨族胶合（只允许在这里出现） ────────────────────────────────────────────
  // 换角色：舞台词汇（情绪+动作）跟随 + 各 Session 舞台状态整体重置 + 应用事件广播。
  // 旧角色的情绪语义名在新角色映射下无意义，不重置会把旧情绪补发给新角色。
  characters.store.onSwitched((next, presentation) => {
    const vocabulary = characterStageVocabulary(presentation);
    characters.stage.updateVocabulary(
      vocabulary.emotions,
      vocabulary.motions,
    );
    characters.stage.reset();
    appEvents.emit({ type: 'character_switched', characterName: next.name, displayName: next.displayName });
  });
  characters.store.onResourcesChanged((character) => {
    appEvents.emit({
      type: 'character_resources_changed',
      characterName: character.name,
    });
  });
  characters.store.onPresentationChanged((character, presentation) => {
    if (character.name === characters.store.current().name) {
      const vocabulary = characterStageVocabulary(presentation);
      characters.stage.updateVocabulary(
        vocabulary.emotions,
        vocabulary.motions,
      );
    }
    appEvents.emit({
      type: 'character_presentation_changed',
      characterName: character.name,
    });
  });
  // 设置变更：前端设置页以外的视图据此刷新。
  settings.settings.subscribe(() => {
    appEvents.emit({ type: 'settings_changed' });
  });
  // KB 域事件进应用通道。
  knowledge.kb.events.on(event => appEvents.emit(event));

  // Memory 只依赖 database 层的 TurnStore/SessionStore，必须先于 openTurns 创建：
  // Turn completed 终态事务内的提取入队闭包由它提供。
  const memory = openMemory({
    dataDb: database.dataDb,
    providers: providers.providers,
    modelBindings: providers.modelBindings,
    session: database.session,
    turns: database.turns,
    usageRecorder: database.usageRecorder,
  });
  const turnFanout = new TurnFanout({
    publishTurnEvent: (sessionId, turnId, event, ttsEnabled) => {
      if (event.type === 'user_message_stored') {
        sessionConnections.publish(sessionId, event);
      } else if (event.type === 'turn_started') {
        sessionConnections.publish(sessionId, {
          type: 'turn_event',
          turnId,
          event,
          ttsEnabled,
        });
      } else {
        sessionConnections.publish(sessionId, { type: 'turn_event', turnId, event });
      }
    },
    emitAppEvent: event => appEvents.emit(event),
    startTurnSpeech: speech.startTurnSpeech,
  });
  const turn = openTurns({
    database,
    settings: settings.settings,
    providers,
    tools,
    knowledge,
    narrative,
    characters: characters.store,
    stage: characters.stage,
    emitAppEvent: event => appEvents.emit(event),
    onTurnCompletedInTransaction: turnId => memory.enqueueTurnExtraction(turnId),
    publishAgentRun: (sessionId, event) => {
      sessionConnections.publish(sessionId, { type: 'agent_run_event', event });
    },
    publishQueuedInput: (sessionId, event) => sessionConnections.publish(sessionId, event),
    fanout: turnFanout,
  });
  notifyBackgroundCompletion = (sessionId, backgroundProcessId, status) => {
    turn.continuations.backgroundProcessCompleted(sessionId, backgroundProcessId, status);
  };
  const commands = openCommands({
    database,
    settings,
    providers,
    tools,
    characters,
    turn,
    publishCompactEvent: event => sessionConnections.publish(event.sessionId, event),
  });
  const backup = openBackup(database.dataDb, input.activeDataDir, providers.providerModels);
  return {
    database,
    settings,
    providers,
    tools,
    knowledge,
    characters,
    narrative,
    speech,
    turn,
    commands,
    memory,
    backup,
    sessionConnections,
    appEvents,
    turnFanout,
    async close() {
      // 先封住自动续接, 再中止并等待根 Turn/手动 Compact 清除各自的 Session 运行记录.
      // 否则数据库关闭后, 在执行 Turn 的 finally 仍可能继续落终态或启动下一根 Turn.
      turn.continuations.shutdown();
      await database.activeSessions.abortAll();
      stopPublishingActiveSessions();
      await turn.agentRuns.shutdown('Application is shutting down');
      await tools.backgroundProcesses.shutdown();
      memory.shutdown();
      database.close();
    },
  };
}
