// Design tokens + keyframe library — must load before any component renders.
import './styles/index.css';

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
export { useRuntimeSettingsSync } from './stores/runtime-settings-sync.js';

export { useCardStore }      from './stores/card-store.js';
export type { CardStoreState } from './stores/card-store.js';

export { useSessionStore }      from './stores/session-store.js';
export type { SessionStoreState, SessionsState } from './stores/session-store.js';

export { useConversationStore } from './stores/conversation-store.js';
export type {
  ConversationStoreState,
  ChatHistoryItem,
  StreamingAssistantMessage,
  AssistantSlice,
} from './stores/conversation-store.js';

export { useDecisionStore }  from './stores/decision-store.js';

export { useKbStore }        from './stores/kb-store.js';
export type { KbStoreState } from './stores/kb-store.js';

export { useThemeStore, useThemeSync } from './stores/theme-store.js';
export { useModelCatalogStore, findEnabledModel } from './stores/model-catalog-store.js';
export type { ModelCatalogStoreState, ModelCatalogStatus } from './stores/model-catalog-store.js';
export type { ThemeStoreState, ThemeMode } from './stores/theme-store.js';

export { useAgentRunStore }            from './stores/agentRunStore.js';
export { useTaskStore }                from './stores/taskStore.js';
export type {
  AgentRunStoreState,
  AgentRunState,
  AgentRunWire,
  AgentRunMessageWire,
  LiveAgentRunInfo,
  AgentRunStatus,
} from './stores/agentRunStore.js';
export type {
  DecisionStoreState,
  DecisionPrompt,
} from './stores/decision-store.js';

// ── Lib ───────────────────────────────────────────────────────────────────────

export { tauriBridge }       from './lib/tauri-bridge.js';
export type { TauriBridge }  from './lib/tauri-bridge.js';

export { createSendQueue }   from './lib/send-queue.js';
export type { SendQueue, SendQueueOptions, QueueEvent } from './lib/send-queue.js';

export { sseConsumer, createSseConsumer } from './lib/sse-consumer.js';
export type { SseStartOptions, SseHandle } from './lib/sse-consumer.js';

export { mountSystemEvents, startSystemSse, stopSystemSse } from './lib/system-sse.js';
export type { SystemEventWindowOptions } from './lib/system-sse.js';

export { ErrorBoundary } from './lib/error-boundary.js';
export type { ErrorBoundaryProps } from './lib/error-boundary.js';

export { showToast } from './lib/toast.js';
export type { ToastHandle, ToastOptions } from './lib/toast.js';

// ── API ───────────────────────────────────────────────────────────────────────

export { sidecarClient, SidecarApiError } from './api/sidecar-client.js';
export type { SidecarClient } from './api/sidecar-client.js';

export { turnsApi }          from './api/turns.js';
export { permissionApi }     from './api/permission.js';
export type { TurnRequest, TurnCreatedResponse } from './api/turns.js';

export { sessionsApi }       from './api/sessions.js';
export type {
  SessionWire,
  MessageWire,
  SessionsListResult,
  SessionsGroupedResult,
  SessionsSearchResult,
  SessionSearchItem,
  ForkResult,
} from './api/sessions.js';

export { providersApi }      from './api/providers.js';
export type {
  ProviderDefinition,
  ProviderHealthWire,
  ProviderConfigWire,
  ProviderConfigInput,
  ProviderConfigPatchInput,
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
  PermissionTimeoutResult,
} from './api/settings.js';

export { cardsApi }          from './api/cards.js';
export type {
  CharacterCard,
  CharacterCardInput,
  CharacterStageCandidate,
  CharacterStageSnapshot,
} from './api/cards.js';

export { transcribeApi }     from './api/transcribe.js';
export type { SttResponse, SttSegment } from './api/transcribe.js';

export { memoryApi }         from './api/memory.js';
export type { MemoryMaintenanceInput } from './api/memory.js';

export { kbApi }             from './api/knowledge-base.js';
export type {
  DocumentAssetWire,
  AssetPageWire,
  DocumentIndexStatus,
  IngestStartedWire,
  KbSearchHitWire,
  KbSearchResultWire,
  KbIngestOptions,
  KbSearchOptions,
} from './api/knowledge-base.js';

export type { AttachmentInputWire } from './api/turns.js';

export { agentRunsApi }              from './api/agentRuns.js';
export { tasksApi }                  from './api/tasks.js';

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
export { AskUserBatchPrompt }      from './decision/AskUserBatchPrompt.js';

// Settings
export { SettingsPanel }           from './settings/SettingsPanel.js';
export { ProvidersTab }            from './settings/providers/ProvidersTab.js';
export { ProviderForm }            from './settings/providers/ProviderForm.js';
export { BindingsTab }             from './settings/providers/BindingsTab.js';
export { CardsTab }                from './settings/character/CardsTab.js';
export { CharacterCardEditor }     from './settings/character/CharacterCardEditor.js';
export { IdentityTab }             from './settings/character/IdentityTab.js';
export { BehaviorTab }             from './settings/character/BehaviorTab.js';
export { VoiceTab }                from './settings/character/voice/VoiceTab.js';
export { Live2DTab }               from './settings/general/Live2DTab.js';
export { ShortcutsTab }            from './settings/general/ShortcutsTab.js';
export { KnowledgeBaseTab }        from './settings/knowledge/KnowledgeBaseTab.js';

// Chat
export { ChatPanel }               from './chat/panels/ChatPanel.js';
export { SessionSwitcher }         from './chat/SessionSwitcher.js';
export { SessionSidebar }          from './chat/sidebar/SessionSidebar.js';
export { ChatHistory }             from './chat/history/ChatHistory.js';
export { UserBubble }              from './chat/messages/UserBubble.js';
export { AssistantBubble }         from './chat/messages/AssistantBubble.js';
export { ToolCallBlock }           from './chat/messages/ToolCallBlock.js';
export { ChatInput }               from './chat/input/ChatInput.js';
export { ExecutionProfileSelector } from './chat/input/ExecutionProfileSelector.js';
export { useChatHistoryScroll }    from './chat/history/useChatHistoryScroll.js';

// AgentRun panel
export { AgentRunPanel }           from './chat/agentRuns/AgentRunPanel.js';
export type { AgentRunPanelProps } from './chat/agentRuns/AgentRunPanel.js';

// Floating dock
export { FloatingDock }            from './floating-dock/FloatingDock.js';

// Setup / onboarding
export { ShellSetupDialog }        from './setup/ShellSetupDialog.js';
export type { ShellSetupDialogProps } from './setup/ShellSetupDialog.js';

// Shell API
export { shellApi }                from './api/shell.js';
export type { ShellStatus, GitInstallResult } from './api/shell.js';
