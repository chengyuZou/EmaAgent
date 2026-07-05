// Design tokens + keyframe library — must load before any component renders.
import './style.css';

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
export type { ThemeStoreState, ThemeMode } from './stores/theme-store.js';

export { useAgentTaskStore }           from './stores/agent-task-store.js';
export type {
  AgentTaskStoreState,
  AgentTaskState,
  AgentTaskWire,
  AgentTaskMessageWire,
  LiveTaskInfo,
  TaskStatus,
} from './stores/agent-task-store.js';
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
} from './api/settings.js';

export { cardsApi }          from './api/cards.js';
export type { CharacterCard, CharacterCardInput } from './api/cards.js';

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

export { agentTasksApi }             from './api/agent-tasks.js';

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
export { KnowledgeBaseTab }        from './settings/KnowledgeBaseTab.js';

// Chat
export { ChatPanel }               from './chat/ChatPanel.js';
export { SessionSwitcher }         from './chat/SessionSwitcher.js';
export { SessionSidebar }          from './chat/SessionSidebar.js';
export { ChatHistory }             from './chat/ChatHistory.js';
export { UserBubble }              from './chat/UserBubble.js';
export { AssistantBubble }         from './chat/AssistantBubble.js';
export { ToolCallBlock }           from './chat/ToolCallBlock.js';
export { ChatInput }               from './chat/ChatInput.js';
export { ModeSelector }            from './chat/ModeSelector.js';
export { useChatHistoryScroll }    from './chat/use-chat-history-scroll.js';

// Task panel
export { TaskPanel }               from './chat/TaskPanel.js';
export type { TaskPanelProps }     from './chat/TaskPanel.js';

// Floating dock
export { FloatingDock }            from './floating-dock/FloatingDock.js';

// Setup / onboarding
export { ShellSetupDialog }        from './setup/ShellSetupDialog.js';
export type { ShellSetupDialogProps } from './setup/ShellSetupDialog.js';

// Shell API
export { shellApi }                from './api/shell.js';
export type { ShellStatus, GitInstallResult } from './api/shell.js';
