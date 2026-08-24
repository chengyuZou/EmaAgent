// 唯一装配点：全部业务对象在此一次成型，族间依赖经 Composition 字段单向传递。
// routes/application/platform 只消费 Composition，不构造业务对象。
import { EventHub } from '../sse/eventHub.js';
import { TurnEventStore } from '../sse/eventStore.js';
import { TurnFanout } from '../sse/turnFanout.js';
import { BackgroundCompletion } from '../application/backgroundCompletion.js';
import { openBackup, type BackupComposition } from './backup.js';
import { openCharacters, type CharactersComposition } from './characters.js';
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
  readonly memory: MemoryComposition;
  readonly backup: BackupComposition;
  readonly eventHub: EventHub;
  readonly turnEvents: TurnEventStore;
  readonly turnFanout: TurnFanout;
  /** 后台进程完成 → 空闲后续跑 Turn 的驱动；start() 由 lifecycle 在 ready 后调用。 */
  readonly backgroundCompletion: BackgroundCompletion;
  /** 进程关闭序列的最后一步；后台工作停驻由 platform/lifecycle 先行完成。 */
  close(): void;
}

export function buildComposition(input: { activeDataDir: string }): Composition {
  const database = openDatabases(input.activeDataDir);
  const settings = openSettings(database.profileDb);
  const providers = openProviders(database.profileDb);
  const eventHub = new EventHub();
  const turnEvents = new TurnEventStore();
  const tools = openTools({
    profileDb: database.profileDb,
    dataDb: database.dataDb,
    activeDataDir: input.activeDataDir,
    session: database.session,
    settings: settings.settings,
    emitBackgroundEvent: event => eventHub.emitApp(event),
    emitStdioApproval: request => eventHub.emitApp({ type: 'mcp_stdio_launch_required', request }),
  });
  const knowledge = openKnowledge(
    database.profileDb,
    providers.providers,
    providers.modelBindings,
    settings.settings,
    database.usageRecorder,
  );
  const characters = openCharacters(database.profileDb, settings.settings);
  const narrative = openNarrative(providers.providers, providers.providerModels, providers.modelBindings);
  const speech = openSpeech(
    database.dataDb,
    input.activeDataDir,
    database.usageRecorder,
    providers.providers,
    providers.modelBindings,
    characters.store,
    settings.settings,
  );

  // ── 跨族胶合（只允许在这里出现） ────────────────────────────────────────────
  // 换角色：舞台词汇（情绪+动作）跟随 + 应用事件广播。
  characters.store.onSwitched(next => {
    characters.stage.updateVocabulary(
      [...next.emotionVocabulary],
      [...next.motionVocabulary],
    );
    eventHub.emitApp({ type: 'character_switched', characterId: next.id, name: next.name });
  });
  characters.store.onPresentationChanged(character => {
    eventHub.emitApp({
      type: 'character_presentation_changed',
      characterId: character.id,
    });
  });
  // 设置变更：前端设置页以外的视图据此刷新。
  settings.settings.subscribe(({ changedKeys, revision }) => {
    eventHub.emitApp({ type: 'settings_changed', changedKeys, revision });
  });
  // KB 域事件进应用通道。
  knowledge.kb.events.on(event => eventHub.emitApp(event));

  // Memory 只依赖 database 层的 TurnStore/SessionStore，必须先于 openTurns 创建：
  // Turn completed 终态事务内的提取入队闭包由它提供。
  const memory = openMemory({
    dataDb: database.dataDb,
    settings: settings.settings,
    providers: providers.providers,
    modelBindings: providers.modelBindings,
    session: database.session,
    turns: database.turns,
    usageRecorder: database.usageRecorder,
    emitApp: event => eventHub.emitApp(event),
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
    emitAppEvent: event => eventHub.emitApp(event),
    onTurnCompletedInTransaction: turnId => memory.enqueueTurnExtraction(turnId),
  });
  const backup = openBackup(database.dataDb, input.activeDataDir, providers.providerModels);
  const turnFanout = new TurnFanout({
    store: turnEvents,
    hub: eventHub,
    startTurnSpeech: speech.startTurnSpeech,
    abortTurn: (sessionId, turnId) => turn.turnExecutor.abort(sessionId, turnId),
  });
  const backgroundCompletion = new BackgroundCompletion({
    source: tools.backgroundProcesses,
    session: database.session,
    turns: database.turns,
    executor: turn.turnExecutor,
    fanout: turnFanout,
  });

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
    memory,
    backup,
    eventHub,
    turnEvents,
    turnFanout,
    backgroundCompletion,
    close() {
      // 先停 Memory 后台工作，再关库；在途 Job 终态遗留由启动恢复收口。
      memory.shutdown();
      database.close();
    },
  };
}
