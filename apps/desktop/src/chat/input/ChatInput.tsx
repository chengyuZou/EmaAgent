import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  Button,
  DropdownMenu,
  IconButton,
  Textarea,
  Tooltip,
  type TextareaHandle,
} from '@ema-agent/ui';
import { sessionWebSocket } from '../../api/sessionWebSocket.js';
import { showToast } from '../../lib/notifications/toast.js';
import {
  hasDraftContent,
  useChatDraftStore,
  type ChatDraft,
} from '../../stores/chatDraft.js';
import { useMainNavigationStore } from '../../layout/navigation.js';
import { useProviderStore } from '../../stores/provider.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useServerStore } from '../../stores/server.js';
import { useSessionStore } from '../../stores/session.js';
import { PendingInteractionView } from '../interactions/PendingInteractionView.js';
import { PermissionModeSelector, TTSButton, useInputOptions } from './controls/InputSelectors.js';
import { ContextMeter } from './controls/ContextMeter.js';
import {
  activeSlashToken,
  SlashCommandMenu,
  type SlashMenuHandle,
  type SlashSelection,
} from './commands/slashCommandMenu.js';
import { useInputCommands } from './commands/inputCommands.js';
import { DraftReferenceList } from './attachments/draftReferenceList.js';
import { invalidateAttachmentSelections, useDraftAttachments } from './attachments/draftAttachments.js';
import { draftFromSession, editChatDraft } from './editChatDraft.js';
import { ModelPicker, useInputModel } from './controls/ModelPicker.js';
import { InputGoalBar, useInputGoal } from './controls/goalBar.js';
import { InputProjectBar } from './controls/inputProjectBar.js';
import { NarrativeToolNotice } from './narrativeToolNotice.js';
import { VoiceInputBar } from './voice/voiceInputBar.js';
import { cancelVoiceInput, startVoiceInput, stopVoiceInput, useVoiceInput } from './voice/voiceInput.js';
import { QueuedInputs } from './queuedInputs.js';

export function ChatInput({
  onSubmit,
}: {
  readonly onSubmit: (submitted: ChatDraft, objective?: string) => Promise<void>;
}): JSX.Element {
  const viewedId = useMainNavigationStore(state => state.viewedSessionId);
  const newProjectId = useMainNavigationStore(state => state.newSessionProjectId);
  const storedDraft = useChatDraftStore(state => (
    viewedId ? state.bySession.get(viewedId) : state.newSessionDraft
  ));
  const viewedSession = useSessionStore(state => viewedId ? state.sessions.byId.get(viewedId) : undefined);
  const sessionActivity = useSessionActivityStore(state => (
    viewedId ? state.bySession.get(viewedId) : undefined
  ));
  const serverReady = useServerStore(state => state.status.kind === 'ok');
  const ttsModelBound = useProviderStore(state => state.bindings.tts !== undefined);
  const sttModelBound = useProviderStore(state => state.bindings.stt !== undefined);
  const [submitting, setSubmitting] = useState(false);
  const voiceInput = useVoiceInput(viewedId);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const textareaRef = useRef<TextareaHandle>(null);
  const slashMenuRef = useRef<SlashMenuHandle | null>(null);
  const voiceActive = voiceInput.kind !== 'idle';
  const recordingTooltip = sttModelBound ? '语音输入' : '请先配置 STT 模型绑定';

  const savedDraft = storedDraft ?? draftFromSession(viewedSession);
  const draft: ChatDraft = viewedSession
    ? {
        ...savedDraft,
        permissionMode: viewedSession.permissionMode,
        ttsEnabled: viewedSession.ttsEnabled,
      }
    : savedDraft;
  const text = draft.text;
  const hasInput = hasDraftContent(draft);
  const sessionRunning = sessionActivity?.running != null;
  const editCurrentDraft = useCallback((edit: (current: ChatDraft) => ChatDraft): void => {
    editChatDraft(viewedId, edit);
  }, [viewedId]);

  function patchCurrentDraft(patch: Partial<ChatDraft>): void {
    editCurrentDraft(current => ({ ...current, ...patch }));
  }

  const {
    catalog,
    shownModelEdit,
    selectedProviderId,
    selectedModelId,
    selectedReasoningEffort,
    selectedModel,
    chooseModel,
    chooseReasoningEffort,
  } = useInputModel(viewedId, viewedSession, draft, patchCurrentDraft);
  const goal = useInputGoal(viewedId, draft.permissionMode, serverReady);
  const { creatingGoal, goalAvailable } = goal;
  const { pickAttachments, handlePaste, removeReference } = useDraftAttachments(viewedId, editCurrentDraft);
  const options = useInputOptions(
    viewedId,
    draft,
    patchCurrentDraft,
    goal.planUnavailableReason,
    goal.refreshGoal,
    pickAttachments,
  );
  const { compacting, runCommand, commandDialogs } = useInputCommands(viewedId, viewedSession, () => {
    if (goal.beginGoal()) textareaRef.current?.el()?.focus();
  });
  const currentProjectId = viewedId
    ? viewedSession?.projectId ?? null
    : newProjectId ?? null;
  const slashToken = slashFilter !== null ? activeSlashToken(text, caret()) : null;
  // 当前命令会立即执行, 因此只有整份文字就是开头的 /搜索词且没有胶囊时才可选.
  // 正文末尾的 /词仍可搜索 Skill, 但不会突然出现 /fork 等会话操作.
  const showCommands = viewedId !== null
    && draft.references.length === 0
    && slashToken?.start === 0
    && slashToken.end === text.length
    && caret() === text.length;

  useEffect(() => {
    const element = textareaRef.current?.el();
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function cancelRecording(): void {
    textareaRef.current?.el()?.focus();
    cancelVoiceInput(viewedId);
  }

  function stopRecording(): void {
    textareaRef.current?.el()?.focus();
    stopVoiceInput(viewedId);
  }

  function caret(): number {
    return textareaRef.current?.el()?.selectionStart ?? text.length;
  }

  function updateText(nextText: string, nextCaret?: number): void {
    patchCurrentDraft({ text: nextText });
    const position = nextCaret ?? nextText.length;
    setSlashFilter(activeSlashToken(nextText, position)?.query ?? null);
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
    if (!hasInput || !serverReady || submitting) return;
    const submitted = draft;
    const objective = creatingGoal ? submitted.text : undefined;
    if (objective !== undefined && !objective.trim()) {
      showToast('请在输入框填写目标正文', { variant: 'warning' });
      return;
    }
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
    invalidateAttachmentSelections(viewedId);
    // 点击发送时先移走这份文字和胶囊. 创建 Session 与附件上传期间新输入仍留在草稿里.
    editCurrentDraft(current => ({ ...current, text: '', references: [] }));
    setSlashFilter(null);
    try {
      await onSubmit(submitted, objective);
      if (objective !== undefined) goal.finishSubmission();
    } catch (error) {
      showToast(error instanceof Error ? `发送失败: ${error.message}` : '发送失败', { variant: 'danger' });
      if (objective !== undefined && viewedId) goal.refreshAfterSubmissionError(error);
    } finally {
      setSubmitting(false);
    }
  }

  function startRecording(): void {
    // 工具栏即将隐藏, 把焦点留在始终可编辑的正文里.
    textareaRef.current?.el()?.focus();
    void startVoiceInput(viewedId);
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

  return (
    <div className="ema-composer-dock pointer-events-none shrink-0 px-4 pb-3 pt-6">
      <div className="ema-chat-content-column pointer-events-auto">
        <PendingInteractionView />
        <QueuedInputs sessionId={viewedId} />
        {viewedId === null && <InputProjectBar projectId={currentProjectId} />}
        <InputGoalBar goal={goal} />
        <NarrativeToolNotice />
        <div className="ema-composer-card relative transition-shadow">
          <SlashCommandMenu
            query={slashFilter}
            sessionId={viewedId}
            projectId={currentProjectId}
            showCommands={showCommands}
            compactAvailable={viewedId !== null && !sessionRunning && !compacting}
            goalAvailable={goalAvailable}
            handleRef={slashMenuRef}
            onSelect={selectSlash}
            onClose={() => setSlashFilter(null)}
          />
          <DraftReferenceList
            sessionId={viewedId}
            references={draft.references}
            onRemove={removeReference}
          />
          <Textarea
            ref={textareaRef}
            containerless
            autoGrow={false}
            rows={1}
            value={text}
            placeholder={creatingGoal ? '描述你的目标, 定义可衡量的成果, 以获得最佳效果…' : '随心输入, / 打开命令与技能…'}
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
          />
          <div className="ema-composer-toolbar">
            <div className="ema-composer-tool-slot">
              <div
                className="ema-composer-tools"
                data-voice-active={voiceActive}
                ref={element => {
                  if (element) element.inert = voiceActive;
                }}
              >
                <DropdownMenu
                  side="top"
                  align="start"
                  widthClass="min-w-48"
                  items={options.plusItems}
                  trigger={(
                    <IconButton
                      size="sm"
                      icon="i-lucide:plus"
                      label="添加内容"
                      className="ema-chat-icon-btn"
                    />
                  )}
                />
                <TTSButton
                  ttsEnabled={draft.ttsEnabled}
                  modelBound={ttsModelBound}
                  onToggle={options.toggleTTS}
                />
                <PermissionModeSelector
                  value={draft.permissionMode}
                  planUnavailableReason={goal.planUnavailableReason}
                  onChange={options.choosePermissionMode}
                />
                {creatingGoal && (
                  <Tooltip content="取消目标标记, 保留输入框文字">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 rounded-full bg-[var(--ema-surface-2)]"
                      disabled={submitting}
                      onClick={goal.cancelGoalIntent}
                    >
                      <span className="i-lucide:circle-x" aria-hidden />
                      目标
                    </Button>
                  </Tooltip>
                )}
                <span className="min-w-2 flex-1" />
                <ContextMeter
                  sessionId={viewedId}
                  modelSelectionPending={shownModelEdit !== null}
                />
                <ModelPicker
                  catalog={catalog}
                  providerId={selectedProviderId}
                  modelId={selectedModelId}
                  reasoningEffort={selectedReasoningEffort}
                  onModelChange={chooseModel}
                  onEffortChange={chooseReasoningEffort}
                />
                <Tooltip content={recordingTooltip} side="top">
                  <span
                    className="inline-flex shrink-0"
                    tabIndex={!sttModelBound ? 0 : undefined}
                  >
                    <IconButton
                      size="sm"
                      icon="i-lucide:mic"
                      label="语音输入"
                      className="ema-chat-icon-btn"
                      disabled={!sttModelBound}
                      onClick={startRecording}
                    />
                  </span>
                </Tooltip>
              </div>
              <VoiceInputBar
                state={voiceInput}
                onCancel={cancelRecording}
                onStop={stopRecording}
              />
            </div>
            {sessionRunning && !hasInput ? (
              <IconButton
                size="sm"
                variant="danger"
                icon="i-ema:stop"
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
                label={sessionRunning ? '加入队列' : '发送'}
                className="rounded-[10px]"
                disabled={!hasInput || !serverReady || submitting
                  || catalog.status !== 'ready' || !selectedModel || shownModelEdit !== null}
                onClick={() => void send()}
              />
            )}
          </div>
        </div>
      </div>
      {commandDialogs}
    </div>
  );
}
