/**
 * @ema-agent/desktop-ui — L3 business layer
 *
 * Public exports:
 *   - Stores (Zustand hooks)
 *   - API clients (typed sidecar HTTP wrappers)
 *   - Lib utilities (tauri-bridge, send-queue, sse-consumer)
 *   - Markdown renderer
 */

// ── Stores ────────────────────────────────────────────────────────────────────

export { useSidecarStore }   from './stores/sidecar-store.js';
export type { SidecarStatus, SidecarStoreState } from './stores/sidecar-store.js';

export { useUiStore }        from './stores/ui-store.js';
export type { UiStoreState, SubWindowName } from './stores/ui-store.js';

export { useSettingsStore }  from './stores/settings-store.js';
export type { SettingsStoreState } from './stores/settings-store.js';

export { useCardStore }      from './stores/card-store.js';
export type { CardStoreState } from './stores/card-store.js';

export { useChatStore }      from './stores/chat-store.js';
export type {
  ChatStoreState,
  ChatHistoryItem,
  StreamingAssistantMessage,
  AssistantSlice,
} from './stores/chat-store.js';

export { useDecisionStore }  from './stores/decision-store.js';
export type {
  DecisionStoreState,
  DecisionPrompt,
  PermissionResponse,
  AskResponse,
} from './stores/decision-store.js';

// ── Lib ───────────────────────────────────────────────────────────────────────

export { tauriBridge }       from './lib/tauri-bridge.js';
export type { TauriBridge }  from './lib/tauri-bridge.js';

export { createSendQueue }   from './lib/send-queue.js';
export type { SendQueue, SendQueueOptions, QueueEvent } from './lib/send-queue.js';

export { sseConsumer, createSseConsumer } from './lib/sse-consumer.js';
export type { SseStartOptions, SseHandle } from './lib/sse-consumer.js';

export { startSystemSse, stopSystemSse } from './lib/system-sse.js';

export { ErrorBoundary } from './lib/error-boundary.js';
export type { ErrorBoundaryProps } from './lib/error-boundary.js';

export { showToast } from './lib/toast.js';
export type { ToastOptions } from './lib/toast.js';

// ── API ───────────────────────────────────────────────────────────────────────

export { sidecarClient, SidecarApiError } from './api/sidecar-client.js';
export type { SidecarClient } from './api/sidecar-client.js';

export { turnsApi }          from './api/turns.js';
export type { CreateTurnRequest, CreateTurnResponse } from './api/turns.js';

export { sessionsApi }       from './api/sessions.js';
export type {
  SessionWire,
  MessageWire,
  SessionsListResult,
  SessionsGroupedResult,
  ForkResult,
} from './api/sessions.js';

export { providersApi }      from './api/providers.js';
export type {
  ProviderDefinitionWire,
  ProviderHealthWire,
  ProviderConfigWire,
  ProviderConfigInput,
  ProbeResultWire,
} from './api/providers.js';

export { modelBindingsApi }  from './api/model-bindings.js';
export type {
  BindingModule,
  ResolvedModelBinding,
  BindingUpsertInput,
} from './api/model-bindings.js';

export { settingsApi }       from './api/settings.js';
export type {
  EventDisplayConfig,
  EventDisplayResult,
  TtsFallbackSettings,
} from './api/settings.js';

export { cardsApi }          from './api/cards.js';
export type { CharacterCardWire, CharacterCardInput } from './api/cards.js';

export { transcribeApi }     from './api/transcribe.js';
export type { TranscribeResult, SttSegment } from './api/transcribe.js';

export { memoryApi }         from './api/memory.js';
export type { MemoryStats, MemoryNode, MemoryItem } from './api/memory.js';

// ── Markdown ──────────────────────────────────────────────────────────────────

export { Markdown } from './markdown/renderer.js';
export type { MarkdownProps } from './markdown/renderer.js';
export {
  extractLangs,
  getProcessor,
  fallbackProcessor,
  clearProcessorCache,
} from './markdown/processor-cache.js';
export type { MarkdownProcessor } from './markdown/processor-cache.js';

// ── Components ────────────────────────────────────────────────────────────────

// Decision
export { DecisionLayer }           from './decision/DecisionLayer.js';
export { PermissionPrompt }        from './decision/PermissionPrompt.js';
export { AskConfirmPrompt }        from './decision/AskConfirmPrompt.js';
export { AskTextPrompt }           from './decision/AskTextPrompt.js';
export { AskChoicePrompt }         from './decision/AskChoicePrompt.js';

// Settings
export { SettingsPanel }           from './settings/SettingsPanel.js';
export { ProvidersTab }            from './settings/ProvidersTab.js';
export { ProviderCard }            from './settings/ProviderCard.js';
export { ProviderForm }            from './settings/ProviderForm.js';
export { BindingsTab }             from './settings/BindingsTab.js';
export { CardsTab }                from './settings/CardsTab.js';
export { CharacterCardEditor }     from './settings/CharacterCardEditor.js';
export { IdentityTab }             from './settings/IdentityTab.js';
export { BehaviorTab }             from './settings/BehaviorTab.js';
export { VoiceTab }                from './settings/VoiceTab.js';
export { Live2DTab }               from './settings/Live2DTab.js';
export { ShortcutsTab }            from './settings/ShortcutsTab.js';
