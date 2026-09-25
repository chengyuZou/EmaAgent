// 编辑当前草稿并处理输入区交互; Session 创建、附件落盘和发送由 onSubmit 负责.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  Button,
  DropdownMenu,
  IconButton,
  Input,
  PromptDialog,
  Textarea,
  type MenuItem,
  type TextareaHandle,
} from '@ema-agent/ui';
import type { TurnInputPart } from '@ema-agent/turn';
import type { NarrativePolicy, ReasoningEffort } from '@ema-agent/session';
import { PASTE_TEXT_MIN_CHARS } from '@ema-agent/attachments/limits';
import { projectsApi } from '../../api/workspaces.js';
import { ServerApiError } from '../../api/client.js';
import { findAvailableModel, providersApi, type AvailableModel } from '../../api/providers.js';
import type { SessionListItem } from '../../api/sessions.js';
import { SessionRequestError, sessionWebSocket } from '../../api/sessionWebSocket.js';
import { showToast } from '../../lib/toast.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import {
  emptyChatDraft,
  hasDraftContent,
  useChatDraftStore,
  type ChatDraft,
  type ChatDraftReference,
} from '../../stores/chatDraft.js';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { useTurnStore } from '../../stores/turn.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useServerStore } from '../../stores/server.js';
import { useSessionStore } from '../../stores/session.js';
import { PendingInteractionView } from '../interactions/PendingInteractionView.js';
import {
  ensureSessionSubscription,
} from '../session/sessionSubscriptions.js';
import { removeSessionFromChat } from '../session/removeSessionFromChat.js';
import { SessionModeSelector, KbButton, PermissionModeSelector } from './InputSelectors.js';
import { ContextMeter } from './ContextMeter.js';
import {
  activeSlashToken,
  SlashCommandMenu,
  type SlashMenuHandle,
  type SlashSelection,
} from './AddInputMenu.js';
import { DraftReferenceList } from './draftReferenceList.js';
import { ModelPicker, type ModelCatalog } from './ModelPicker.js';

const COMPACT_ERRORS: Record<string, string> = {
  session_busy: '当前会话正忙, 请稍后再试',
  compact_below_threshold: '历史还短, 不需要压缩',
  nothing_to_compact: '没有可压缩的内容',
  provider_not_configured: '未配置可用模型',
  compact_failed: '压缩失败, 请重试',
};

function isLlmImagePath(filePath: string): boolean {
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(filePath.split('.').pop()?.toLowerCase() ?? '');
}

function queuedInputText(input: readonly TurnInputPart[]): string {
  const text = input
    .filter((part): part is Extract<TurnInputPart, { type: 'text' }> => (
      part.type === 'text'
    ))
    .map((part) => part.text)
    .join('')
    .trim();
  const references = input.filter((part) => part.type !== 'text').length;
  return text || `${references} 个附件或技能`;
}

function draftFromSession(session: SessionListItem | undefined): ChatDraft {
  return {
    ...emptyChatDraft(),
    sessionMode: session?.sessionMode ?? 'chat',
    narrativePolicy: session?.narrativePolicy ?? 'auto',
    permissionMode: session?.permissionMode ?? 'default',
    ttsEnabled: session?.ttsEnabled ?? false,
    reasoningEffort: session?.reasoningEffort ?? 'off',
  };
}

export function ChatInput({
  onSubmit,
}: {
  readonly onSubmit: (submitted: ChatDraft) => Promise<void>;
}): JSX.Element {
  const viewedId = useChatNavigationStore(state => state.viewedSessionId);
  const newProjectId = useChatNavigationStore(state => state.newSessionProjectId);
  const newSessionCwd = useChatNavigationStore(state => state.newSessionCwd);
  const storedDraft = useChatDraftStore(state => (
    viewedId ? state.bySession.get(viewedId) : state.newSessionDraft
  ));
  const viewedSession = useSessionStore(state => viewedId ? state.sessions.byId.get(viewedId) : undefined);
  const pinnedProjects = useSessionStore(state => state.sessions.pinnedProjects);
  const projects = useSessionStore(state => state.sessions.projects);
  const sessionActivity = useSessionActivityStore(state => (
    viewedId ? state.bySession.get(viewedId) : undefined
  ));
  const serverReady = useServerStore(state => state.status.kind === 'ok');
  const [catalog, setCatalog] = useState<ModelCatalog>({ status: 'loading', models: [] });
  const [modelEdit, setModelEdit] = useState<{
    sessionId: string;
    providerId: string;
    modelId: string;
    reasoningEffort: ReasoningEffort;
    status: 'saving' | 'error';
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [changingProject, setChangingProject] = useState(false);
  const [recording, setRecording] = useState(false);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<TextareaHandle>(null);
  const slashMenuRef = useRef<SlashMenuHandle | null>(null);
  const modelEditVersion = useRef(0);
  const reasoningResetKey = useRef<string | null>(null);

  const savedDraft = storedDraft ?? draftFromSession(viewedSession);
  const draft: ChatDraft = viewedSession
    ? {
        ...savedDraft,
        sessionMode: viewedSession.sessionMode,
        narrativePolicy: viewedSession.narrativePolicy,
        permissionMode: viewedSession.permissionMode,
        ttsEnabled: viewedSession.ttsEnabled,
      }
    : savedDraft;
  const text = draft.text;
  const hasInput = hasDraftContent(draft);
  const sessionRunning = sessionActivity?.running != null;
  const turnRunning = sessionActivity?.running?.kind === 'turn';
  // 新对话从草稿取选择; 已有对话从 Session 取已保存事实. 保存期间显示用户刚选的值, 失败时保留它但禁止发送.
  const shownModelEdit = modelEdit?.sessionId === viewedId ? modelEdit : null;
  const selectedProviderId = viewedId
    ? shownModelEdit?.providerId ?? viewedSession?.providerId
    : draft.providerId;
  const selectedModelId = viewedId
    ? shownModelEdit?.modelId ?? viewedSession?.modelId
    : draft.modelId;
  const selectedReasoningEffort = viewedId
    ? shownModelEdit?.reasoningEffort ?? viewedSession?.reasoningEffort ?? 'off'
    : draft.reasoningEffort;
  const selectedModel = findAvailableModel(catalog.models, selectedProviderId, selectedModelId);
  const currentProjectId = viewedId
    ? viewedSession?.projectId ?? null
    : newProjectId ?? null;
  const availableProjects = [...pinnedProjects, ...projects];
  const currentProject = availableProjects.find(project => project.id === currentProjectId);
  const inheritedNewCwd = currentProject?.folders.find(folder => folder.isPrimary)?.path ?? '';
  const displayedNewCwd = newSessionCwd ?? inheritedNewCwd;
  const slashToken = slashFilter !== null ? activeSlashToken(text, caret()) : null;
  // 当前命令会立即执行, 因此只有整份文字就是开头的 /搜索词且没有胶囊时才可选.
  // 正文末尾的 /词仍可搜索 Skill, 但不会突然出现 /fork 等会话操作.
  const showCommands = viewedId !== null
    && draft.references.length === 0
    && slashToken?.start === 0
    && slashToken.end === text.length
    && caret() === text.length;

  async function changeProject(projectId: string | null): Promise<void> {
    if (projectId === currentProjectId || changingProject) return;
    if (!viewedId) {
      useChatNavigationStore.getState().openNewSession(projectId ?? undefined);
      return;
    }
    if (!viewedSession) return;

    setChangingProject(true);
    try {
      if (projectId) {
        await projectsApi.addSession(projectId, { sessionId: viewedId });
      } else if (viewedSession.projectId) {
        await projectsApi.removeSession(viewedSession.projectId, viewedId);
      }
      await useSessionStore.getState().loadSessions();
      const refreshError = useSessionStore.getState().error;
      if (refreshError) {
        showToast(
          `项目归属已保存，但列表刷新失败: ${refreshError}`,
          { variant: 'warning' },
        );
      }
    } catch (error) {
      showToast(
        error instanceof Error ? `切换项目失败: ${error.message}` : '切换项目失败',
        { variant: 'danger' },
      );
    } finally {
      setChangingProject(false);
    }
  }

  async function pickNewCwd(): Promise<void> {
    try {
      const path = await tauriBridge.openFileDialog({ directory: true });
      if (path) useChatNavigationStore.getState().setNewSessionCwd(path);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '选择执行目录失败',
        { variant: 'danger' },
      );
    }
  }

  const projectItems = (): MenuItem[] => [
    {
      kind: 'item',
      id: 'project:none',
      label: '不在项目中工作',
      icon: currentProjectId === null ? 'i-lucide:check' : 'i-lucide:x',
      onSelect: () => void changeProject(null),
    },
    ...(availableProjects.length > 0 ? [{ kind: 'separator' } as const] : []),
    ...availableProjects.map((project): MenuItem => ({
      kind: 'item',
      id: `project:${project.id}`,
      label: project.name,
      icon: project.id === currentProjectId ? 'i-lucide:check' : 'i-lucide:folder',
      onSelect: () => void changeProject(project.id),
    })),
  ];

  const editCurrentDraft = useCallback((edit: (current: ChatDraft) => ChatDraft): void => {
    const drafts = useChatDraftStore.getState();
    // 文件选择、录音和发送都会异步返回. 写入时重新取这份草稿,
    // 避免一个较早的回调把用户刚输入的文字或胶囊覆盖掉.
    const current = viewedId
      ? drafts.bySession.get(viewedId)
        ?? draftFromSession(useSessionStore.getState().sessions.byId.get(viewedId))
      : drafts.newSessionDraft;
    const next = edit(current);
    if (viewedId) drafts.setForSession(viewedId, next);
    else drafts.setForNewSession(next);
  }, [viewedId]);

  function patchCurrentDraft(patch: Partial<ChatDraft>): void {
    editCurrentDraft(current => ({ ...current, ...patch }));
  }

  function appendReferences(items: readonly ChatDraftReference[]): void {
    editCurrentDraft(current => ({
      ...current,
      references: [...current.references, ...items],
    }));
  }

  const removeReference = useCallback((draftId: string): void => {
    editCurrentDraft(current => ({
      ...current,
      references: current.references.filter(reference => reference.draftId !== draftId),
    }));
  }, [editCurrentDraft]);

  function showSessionPreferenceError(error: unknown): void {
    showToast(
      error instanceof Error ? `保存会话设置失败: ${error.message}` : '保存会话设置失败',
      { variant: 'danger' },
    );
  }

  useEffect(() => {
    let active = true;
    let request = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const loadModels = (): void => {
      const current = ++request;
      setCatalog({ status: 'loading', models: [] });
      void providersApi.listAvailable('llm').then(({ models }) => {
        if (active && current === request) setCatalog({ status: 'ready', models: [...models] });
      }).catch(() => {
        if (active && current === request) setCatalog({ status: 'error', models: [] });
      });
    };
    loadModels();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type !== 'provider_config_changed' && event.type !== 'provider_models_changed') return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadModels, 150);
    });
    return () => {
      active = false;
      request += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, []);

  // Settings 窗口可能把当前模型改为不支持推理. 目录刷新后同样要把 Session 的旧强度关掉.
  useEffect(() => {
    if (!viewedId || !viewedSession || !selectedModel || selectedModel.capability !== 'llm'
      || selectedModel.reasoning === true || viewedSession.reasoningEffort === 'off') {
      // 同一模型以后仍可能在 Settings 再次关闭推理能力, 不能永久记住上次重置.
      reasoningResetKey.current = null;
      return;
    }
    if (shownModelEdit) return;
    const key = `${viewedId}:${viewedSession.providerId}:${viewedSession.modelId}`;
    if (reasoningResetKey.current === key) return;
    reasoningResetKey.current = key;
    void saveModelChoice(viewedId, viewedSession.providerId!, viewedSession.modelId!, 'off', false);
  }, [catalog, viewedId, viewedSession, selectedModel, shownModelEdit]);

  async function saveModelChoice(
    sessionId: string,
    providerId: string,
    modelId: string,
    reasoningEffort: ReasoningEffort,
    changeModel: boolean,
  ): Promise<void> {
    const version = ++modelEditVersion.current;
    setModelEdit({ sessionId, providerId, modelId, reasoningEffort, status: 'saving' });
    try {
      if (changeModel) {
        await useSessionStore.getState().setModel(sessionId, providerId, modelId, reasoningEffort);
        useTurnStore.getState().invalidateContextUsage(sessionId);
      } else {
        await useSessionStore.getState().setReasoningEffort(sessionId, reasoningEffort);
      }
      if (modelEditVersion.current === version) setModelEdit(null);
    } catch (error) {
      if (modelEditVersion.current === version) {
        setModelEdit({ sessionId, providerId, modelId, reasoningEffort, status: 'error' });
      }
      showToast(error instanceof Error ? `保存模型设置失败: ${error.message}` : '保存模型设置失败', { variant: 'danger' });
    }
  }

  function chooseModel(model: AvailableModel): void {
    const effort = model.capability === 'llm' && model.reasoning === true
      ? selectedReasoningEffort : 'off';
    if (viewedId) {
      void saveModelChoice(viewedId, model.providerId, model.modelId, effort, true);
    } else {
      patchCurrentDraft({ providerId: model.providerId, modelId: model.modelId, reasoningEffort: effort });
    }
  }

  function chooseReasoningEffort(reasoningEffort: ReasoningEffort): void {
    if (!selectedProviderId || !selectedModelId) return;
    if (viewedId) {
      void saveModelChoice(viewedId, selectedProviderId, selectedModelId, reasoningEffort, false);
    } else {
      patchCurrentDraft({ reasoningEffort });
    }
  }

  useEffect(() => {
    const element = textareaRef.current?.el();
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function caret(): number { return textareaRef.current?.el()?.selectionStart ?? text.length; }

  function updateText(nextText: string, nextCaret?: number): void {
    patchCurrentDraft({ text: nextText });
    const position = nextCaret ?? nextText.length;
    setSlashFilter(activeSlashToken(nextText, position)?.query ?? null);
  }

  async function pickAttachments(): Promise<void> {
    const paths = await tauriBridge.openFileDialogMultiple();
    appendReferences(paths.map(sourcePath => (
      isLlmImagePath(sourcePath)
        ? { draftId: crypto.randomUUID(), type: 'image' as const, sourcePath, name: sourcePath.split(/[\\/]/).pop() }
        : { draftId: crypto.randomUUID(), type: 'file_reference' as const, path: sourcePath }
    )));
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const image = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      appendReferences([{ draftId: crypto.randomUUID(), type: 'image', file: image, name: image.name || undefined }]);
      return;
    }
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (pasted.length >= PASTE_TEXT_MIN_CHARS) {
      event.preventDefault();
      appendReferences([{
        draftId: crypto.randomUUID(),
        type: 'pasted_text',
        content: pasted,
        preview: `${pasted.slice(0, 120)}${pasted.length > 120 ? '…' : ''}`,
      }]);
    }
  }

  async function runCompact(): Promise<void> {
    if (
      !viewedId
      || compacting
      || useSessionActivityStore.getState().bySession.get(viewedId)?.running != null
    ) return;
    setCompacting(true);
    try {
      ensureSessionSubscription(viewedId);
      const result = await sessionWebSocket.startCompaction(viewedId);
      if (result.status === 'cancelled') {
        showToast('压缩已取消', { variant: 'info' });
      } else {
        showToast(`已压缩 ${result.beforeTokens} → ${result.afterTokens} tokens`, { variant: 'success' });
      }
    } catch (error) {
      const code = error instanceof ServerApiError || error instanceof SessionRequestError
        ? error.code
        : undefined;
      let message = '压缩失败';
      if (code && COMPACT_ERRORS[code]) message = COMPACT_ERRORS[code];
      else if (error instanceof Error) message = error.message;
      showToast(message, { variant: 'danger' });
    } finally {
      setCompacting(false);
    }
  }

  async function runCommand(name: string): Promise<void> {
    const sessions = useSessionStore.getState();
    if (name === 'compact') return runCompact();
    if (name === 'new') {
      useChatNavigationStore.getState().openNewSession();
      return;
    }
    if (!viewedId) return;
    if (name === 'fork') {
      useChatNavigationStore.getState().viewSession(await sessions.forkSession(viewedId));
      return;
    }
    if (name === 'rename') {
      setRenameOpen(true);
      return;
    }
    if (name === 'pin') return sessions.pinSession(viewedId, !(viewedSession?.pinned ?? false));
    if (name === 'archive') {
      await sessions.archiveSession(viewedId);
      removeSessionFromChat(viewedId);
      return;
    }
    showToast(`未知命令: /${name}`, { variant: 'warning' });
  }

  function selectSlash(selection: SlashSelection): void {
    const token = activeSlashToken(text, caret());
    if (!token) return;
    if (selection.kind === 'command' && !showCommands) return;
    const nextText = text.slice(0, token.start) + text.slice(token.end);
    // 命令只由菜单选择触发. 手敲 /fork 然后点击发送仍是普通文字,
    // 不会从这里进入命令, 也不会在后端产生一条伪造的命令消息.
    editCurrentDraft(current => ({
      ...current,
      text: nextText,
      references: selection.kind === 'skill'
        && !current.references.some(part => (
          part.type === 'skill_reference' && part.path === selection.skill.path
        ))
        ? [...current.references, {
            draftId: crypto.randomUUID(),
            type: 'skill_reference',
            name: selection.skill.name,
            path: selection.skill.path,
          }]
        : current.references,
    }));
    setSlashFilter(null);
    if (selection.kind === 'skill') {
      const textarea = textareaRef.current?.el();
      textarea?.focus();
      textarea?.setSelectionRange(token.start, token.start);
    }
    if (selection.kind === 'command') {
      void runCommand(selection.command.name).catch((error) => {
        showToast(
          error instanceof Error ? error.message : '命令执行失败',
          { variant: 'danger' },
        );
      });
    }
  }

  async function send(): Promise<void> {
    if (!hasInput || !serverReady || submitting || compacting) return;
    const submitted = draft;
    if (catalog.status !== 'ready') {
      showToast(catalog.status === 'error' ? '模型目录加载失败, 请重试' : '模型目录仍在加载', { variant: 'danger' });
      return;
    }
    if (!selectedModel || !selectedProviderId || !selectedModelId) {
      showToast('请先选择已配置并启用的 LLM 模型', { variant: 'danger' });
      return;
    }
    if (shownModelEdit?.status === 'error') {
      showToast('模型设置未保存, 请重新选择模型或推理强度', { variant: 'danger' });
      return;
    }
    setSubmitting(true);
    // 点击发送时先移走这份文字和胶囊. 创建 Session 与附件上传期间新输入仍留在草稿里.
    editCurrentDraft(current => ({ ...current, text: '', references: [] }));
    setSlashFilter(null);
    try {
      await onSubmit(submitted);
    } catch (error) {
      showToast(error instanceof Error ? `发送失败: ${error.message}` : '发送失败', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleRecording(): Promise<void> {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(media);
      const recordingSessionId = viewedId;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        setRecording(false);
        media.getTracks().forEach((track) => track.stop());
        const audio = new Blob(chunks, { type: recorder.mimeType });
        void providersApi.transcribe({ audio, mime: recorder.mimeType })
          .then((result) => {
            // 转写是异步的. 回来时必须追加到该 Session 的最新草稿, 不能用开始录音时闭包里的旧内容覆盖用户后续输入.
            const drafts = useChatDraftStore.getState();
            const latest = recordingSessionId
              ? drafts.bySession.get(recordingSessionId) ?? emptyChatDraft()
              : drafts.newSessionDraft;
            const next = {
              ...latest,
              text: `${latest.text}${result.text.trim()}`,
            };
            if (recordingSessionId) drafts.setForSession(recordingSessionId, next);
            else drafts.setForNewSession(next);
          })
          .catch((error) => {
            showToast(
              error instanceof Error ? error.message : '语音转写失败',
              { variant: 'danger' },
            );
          });
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '无法使用麦克风',
        { variant: 'danger' },
      );
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const slashHandled = slashFilter !== null
      && ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)
      && slashMenuRef.current?.handleKey(
        event.key as 'ArrowUp' | 'ArrowDown' | 'Enter',
      );
    if (slashHandled) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && slashFilter !== null) {
      setSlashFilter(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const narrativeLabels: Record<NarrativePolicy, string> = {
    auto: '自动',
    always: '始终',
    off: '关闭',
  };
  const plusItems = (): MenuItem[] => [
    {
      kind: 'item',
      id: 'add:attachment',
      label: '添加文件或图片',
      icon: 'i-lucide:paperclip',
      onSelect: () => void pickAttachments(),
    },
    {
      kind: 'submenu',
      id: 'add:narrative',
      label: 'Narrative选择',
      icon: 'i-lucide:book-open',
      items: (['auto', 'always', 'off'] as const).map(narrativePolicy => ({
        kind: 'item',
        id: `narrative:${narrativePolicy}`,
        label: narrativeLabels[narrativePolicy],
        icon: draft.narrativePolicy === narrativePolicy ? 'i-lucide:check' : 'i-lucide:circle',
        onSelect: () => {
          if (viewedId) {
            void useSessionStore.getState()
              .setNarrativePolicy(viewedId, narrativePolicy)
              .catch(showSessionPreferenceError);
          } else {
            patchCurrentDraft({ narrativePolicy });
          }
        },
      })),
    },
  ];

  return (
    <div className="ema-composer-dock pointer-events-none shrink-0 px-4 pb-3 pt-6">
      <div className="pointer-events-auto mx-auto max-w-3xl">
        <PendingInteractionView />
        {/* 整组常驻挂载 + 网格裁剪, 开合双向平滑(动画铁律); 单行入场 fade,
            单行删除瞬时(由容器平滑收拢兜底, 不为单行再造延迟卸载). */}
        <div
          className="ema-collapsible"
          style={{
            gridTemplateRows: sessionActivity && sessionActivity.queuedInputs.length > 0 ? '1fr' : '0fr',
            opacity: sessionActivity && sessionActivity.queuedInputs.length > 0 ? 1 : 0,
          }}
        >
          <div>
            <div className="mb-2 flex flex-col gap-1.5">
              {sessionActivity?.queuedInputs.map((item) => (
                <div
                  key={item.id}
                  className="ema-fade-in flex items-center gap-2 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-2 text-xs"
                >
                  <span className="i-lucide:clock-3 text-[var(--ema-text-tertiary)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[var(--ema-text-secondary)]">
                    {queuedInputText(item.input)}
                  </span>
                  {item.delivery === 'after_turn' && turnRunning && (
                    <button
                      className="text-[var(--ema-primary)] hover:underline"
                      onClick={() => void sessionWebSocket.guideQueuedInput(viewedId!, item.id)}
                    >
                      立即引导
                    </button>
                  )}
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon="i-lucide:x"
                    label="删除排队输入"
                    onClick={() => void sessionWebSocket.removeQueuedInput(viewedId!, item.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div
          className="ema-fade-in mb-2 flex w-full min-w-0 items-center gap-2 px-1 text-xs text-[var(--ema-text-secondary)]"
        >
          <DropdownMenu
            side="top"
            align="start"
            widthClass="min-w-56"
            items={projectItems}
            trigger={(
              <Button
                variant="ghost"
                size="sm"
                disabled={changingProject || (viewedId !== null && !viewedSession)}
                className="max-w-56 gap-1.5 rounded-md px-2"
                title={currentProject?.name ?? '不在项目中工作'}
              >
                <span className="i-lucide:folder shrink-0 text-sm" aria-hidden />
                <span className="truncate">{currentProject?.name ?? '选择项目'}</span>
                <span className="i-lucide:chevron-down shrink-0 text-xs" aria-hidden />
              </Button>
            )}
          />
          {!viewedId && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <label htmlFor="new-session-cwd" className="shrink-0">cwd:</label>
              <Input
                id="new-session-cwd"
                aria-label="新对话执行目录"
                value={displayedNewCwd}
                onChange={event => useChatNavigationStore.getState().setNewSessionCwd(event.target.value)}
                placeholder="使用 Ema 默认工作目录"
                className="min-w-0 flex-1"
              />
              {currentProject && currentProject.folders.length > 0 && (
                <DropdownMenu
                  side="top"
                  align="end"
                  widthClass="min-w-64 max-w-lg"
                  items={currentProject.folders.map(folder => ({
                    kind: 'item',
                    id: `folder:${folder.path}`,
                    label: folder.path,
                    icon: folder.path === displayedNewCwd ? 'i-lucide:check' : 'i-lucide:folder',
                    onSelect: () => useChatNavigationStore.getState().setNewSessionCwd(folder.path),
                  }))}
                  trigger={(
                    <IconButton size="sm" variant="ghost" icon="i-lucide:list" label="从项目文件夹中选择" />
                  )}
                />
              )}
              <IconButton
                size="sm"
                variant="ghost"
                icon="i-lucide:folder-open"
                label="选择执行目录"
                onClick={() => void pickNewCwd()}
              />
            </div>
          )}
        </div>
        <div className="ema-composer-card relative transition-shadow">
          <SlashCommandMenu
            query={slashFilter}
            sessionId={viewedId}
            projectId={currentProjectId}
            showCommands={showCommands}
            compactAvailable={viewedId !== null && !sessionRunning && !compacting}
            handleRef={slashMenuRef}
            onSelect={selectSlash}
            onClose={() => setSlashFilter(null)}
          />
          <DraftReferenceList
            references={draft.references}
            onRemove={removeReference}
          />
          <Textarea
            ref={textareaRef}
            containerless
            autoGrow={false}
            rows={1}
            value={text}
            placeholder="随心输入, / 打开命令与技能…"
            className="min-h-[64px] w-full resize-none border-none overflow-y-auto rounded-[22px] bg-transparent px-4 py-3 text-sm text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)] focus:outline-none"
            style={{ maxHeight: 200 }}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => (
              updateText(event.target.value, event.target.selectionStart)
            )}
            onSelect={(event) => {
              const element = event.currentTarget;
              setSlashFilter(activeSlashToken(element.value, element.selectionStart)?.query ?? null);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={compacting}
          />
          <div className="flex min-w-0 items-center gap-1 border-t border-[var(--ema-border)] px-2 py-1.5">
            <DropdownMenu
              side="top"
              align="start"
              widthClass="min-w-48"
              items={plusItems}
              trigger={(
                <IconButton
                  size="sm"
                  icon="i-lucide:plus"
                  label="添加内容"
                  className="ema-chat-icon-btn"
                />
              )}
            />
            <KbButton
              visible={draft.sessionMode === 'work'}
              selectedIds={draft.selectedAssetIds}
              onChange={(selectedAssetIds) => patchCurrentDraft({ selectedAssetIds })}
            />
            <IconButton
              size="sm"
              icon={draft.ttsEnabled ? 'i-lucide:volume-2' : 'i-lucide:volume-x'}
              label="切换 TTS"
              toggled={draft.ttsEnabled}
              className="ema-chat-icon-btn"
              onClick={() => {
                if (viewedId) {
                  void useSessionStore.getState()
                    .setTtsEnabled(viewedId, !draft.ttsEnabled)
                    .catch(showSessionPreferenceError);
                } else {
                  patchCurrentDraft({ ttsEnabled: !draft.ttsEnabled });
                }
              }}
            />
            <PermissionModeSelector
              value={draft.permissionMode}
              onChange={(permissionMode) => {
                if (viewedId) {
                  void useSessionStore.getState()
                    .setPermissionMode(viewedId, permissionMode)
                    .catch(showSessionPreferenceError);
                } else {
                  patchCurrentDraft({ permissionMode });
                }
              }}
            />
            <span className="min-w-2 flex-1" />
            <ContextMeter
              sessionId={viewedId}
              contextWindow={selectedModel?.capability === 'llm' ? selectedModel.contextWindow : undefined}
            />
            <SessionModeSelector
              value={draft.sessionMode}
              onChange={(sessionMode) => {
                if (sessionMode === 'chat') patchCurrentDraft({ selectedAssetIds: [] });
                if (viewedId) {
                  void useSessionStore.getState()
                    .setSessionMode(viewedId, sessionMode)
                    .catch(showSessionPreferenceError);
                } else {
                  patchCurrentDraft({ sessionMode });
                }
              }}
            />
            <ModelPicker
              catalog={catalog}
              providerId={selectedProviderId}
              modelId={selectedModelId}
              reasoningEffort={selectedReasoningEffort}
              onModelChange={chooseModel}
              onEffortChange={chooseReasoningEffort}
            />
            <IconButton
              size="sm"
              variant={recording ? 'danger' : 'default'}
              icon={recording ? 'i-lucide:square' : 'i-lucide:mic'}
              label={recording ? '停止录音' : '语音输入'}
              className={recording ? undefined : 'ema-chat-icon-btn'}
              onClick={() => void toggleRecording()}
            />
            {sessionRunning && !hasInput ? (
              <IconButton
                size="sm"
                variant="danger"
                icon="i-lucide:square"
                label="停止生成"
                onClick={() => {
                  if (!viewedId || !sessionActivity?.running) return;
                  if (sessionActivity.running.kind === 'turn') {
                    void sessionWebSocket.cancelTurn(viewedId, sessionActivity.running.turnId);
                  } else {
                    void sessionWebSocket.cancelCompact(viewedId, sessionActivity.running.compactId);
                  }
                }}
              />
            ) : (
              <IconButton
                size="md"
                variant="primary"
                icon="i-lucide:arrow-up"
                label={turnRunning ? '加入队列' : '发送'}
                className="rounded-[10px]"
                disabled={!hasInput || !serverReady || submitting || compacting
                  || catalog.status !== 'ready' || !selectedModel || shownModelEdit !== null}
                onClick={() => void send()}
              />
            )}
          </div>
        </div>
      </div>
      {renameOpen && viewedSession && (
        <PromptDialog
          open
          title="重命名聊天"
          message="为当前聊天输入新标题."
          initialValue={viewedSession.title ?? ''}
          placeholder="聊天标题"
          onConfirm={(value) => {
            setRenameOpen(false);
            if (viewedId && value.trim()) {
              void useSessionStore.getState().renameSession(viewedId, value.trim());
            }
          }}
          onCancel={() => setRenameOpen(false)}
        />
      )}
    </div>
  );
}
