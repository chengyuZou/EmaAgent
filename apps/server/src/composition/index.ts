// 唯一装配点：全部业务对象在此一次成型，族间依赖经 Composition 字段单向传递。
// routes/application/platform 只消费 Composition，不构造业务对象。
import { EventHub } from '../sse/eventHub.js';
import { TurnEventStore } from '../sse/eventStore.js';
import { TurnFanout } from '../sse/turnFanout.js';
import { openCharacters, type CharactersComposition } from './characters.js';
import { openDatabases, type DatabaseComposition } from './database.js';
import { openKnowledge, type KnowledgeComposition } from './knowledge.js';
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
  readonly eventHub: EventHub;
  readonly turnEvents: TurnEventStore;
  readonly turnFanout: TurnFanout;
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
    database.dataDb,
    providers.providers,
    providers.modelBindings,
    settings.settings,
  );
  const characters = openCharacters(database.profileDb);
  const narrative = openNarrative(providers.providers, providers.providerModels, providers.modelBindings);
  const speech = openSpeech(
    database.dataDb,
    input.activeDataDir,
    providers.providers,
    providers.modelBindings,
    characters.cards,
  );

  // ── 跨族胶合（只允许在这里出现） ────────────────────────────────────────────
  // 换卡：情绪词汇跟随 + 应用事件广播。
  characters.cards.onSwitched(next => {
    characters.emotion.updateVocabulary([...next.emotionVocabulary]);
    eventHub.emitApp({ type: 'character_card_switched', cardId: next.id, name: next.name });
  });
  characters.cards.onPresentationChanged(card => {
    eventHub.emitApp({ type: 'character_presentation_changed', cardId: card.id });
  });
  // 设置变更：前端设置页以外的视图据此刷新。
  settings.settings.subscribe(({ changedKeys, revision }) => {
    eventHub.emitApp({ type: 'settings_changed', changedKeys, revision });
  });
  // KB 域事件进应用通道。
  knowledge.kb.events.on(event => eventHub.emitApp(event));

  const turn = openTurns({
    database,
    settings: settings.settings,
    providers,
    tools,
    knowledge,
    narrative,
    cards: characters.cards,
    emitAppEvent: event => eventHub.emitApp(event),
  });
  const turnFanout = new TurnFanout({
    store: turnEvents,
    hub: eventHub,
    startTurnSpeech: speech.startTurnSpeech,
    abortTurn: (sessionId, turnId) => turn.turnExecutor.abort(sessionId, turnId),
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
    eventHub,
    turnEvents,
    turnFanout,
    close() {
      database.close();
    },
  };
}
