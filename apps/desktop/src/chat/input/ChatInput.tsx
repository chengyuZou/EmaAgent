// 编辑当前草稿并处理输入区交互; Session 创建、附件落盘和发送由 onSubmit 负责.
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
import type { TurnInputPart } from '@ema-agent/turn';
import { providersApi } from '../../api/providers.js';
import type { SessionListItem } from '../../api/sessions.js';
import { sessionWebSocket } from '../../api/sessionWebSocket.js';
import { showToast } from '../../lib/toast.js';
import {
  emptyChatDraft,
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
import { PermissionModeSelector, TtsButton, useInputOptions } from './controls/InputSelectors.js';
import { ContextMeter } from './controls/ContextMeter.js';
import {
  activeSlashToken,
  SlashCommandMenu,
  useInputCommands,
  type SlashMenuHandle,
  type SlashSelection,
} from './AddInputMenu.js';
import { DraftReferenceList, useDraftAttachments } from './draftAttachments.js';
import { ModelPicker, useInputModel } from './controls/ModelPicker.js';
import { InputGoalBar, useInputGoal } from './controls/goalBar.js';
import { InputProjectBar } from './inputProjectBar.js';
import { NarrativeToolNotice } from './narrativeToolNotice.js';
import { VoiceInputBar, type VoiceInputState } from './voiceInputBar.js';

interface VoiceRecording {
  readonly sessionId: string | null;
  readonly abort: AbortController;
  media: MediaStream | null;
  recorder: MediaRecorder | null;
}

function releaseRecording(recording: VoiceRecording): void {
  recording.abort.abort();
  if (recording.recorder?.state === 'recording') {
    recording.recorder.stop();
  }
  recording.media?.getTracks().forEach(track => track.stop());
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
    permissionMode: session?.permissionMode ?? 'default',
    ttsEnabled: session?.ttsEnabled ?? false,
    reasoningEffort: session?.reasoningEffort ?? 'off',
  };
}

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
  const [voiceInput, setVoiceInput] = useState<VoiceInputState>({ kind: 'idle' });
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
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
  const turnRunning = sessionActivity?.running?.kind === 'turn';
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
  const { pickAttachments, handlePaste, removeReference } = useDraftAttachments(editCurrentDraft);
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

  useEffect(() => () => {
    const active = recordingRef.current;
    recordingRef.current = null;
    if (active) releaseRecording(active);
  }, []);

  const cancelRecording = useCallback((): void => {
    const active = recordingRef.current;
    // 先取消这次录音的归属, stop 触发的回调才不会把丢弃的音频送去转写.
    recordingRef.current = null;
    textareaRef.current?.el()?.focus();
    setVoiceInput({ kind: 'idle' });
    if (active) releaseRecording(active);
  }, []);

  const stopRecording = useCallback((): void => {
    const recorder = recordingRef.current?.recorder;
    if (recorder?.state !== 'recording') return;
    textareaRef.current?.el()?.focus();
    setVoiceInput({ kind: 'transcribing' });
    recorder.stop();
  }, []);

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
    if (!hasInput || !serverReady || submitting || compacting) return;
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

  async function startRecording(): Promise<void> {
    if (recordingRef.current) return;
    if (!useProviderStore.getState().bindings.stt) {
      showToast('请先配置 STT 模型绑定', { variant: 'warning' });
      return;
    }
    const active: VoiceRecording = {
      sessionId: viewedId,
      abort: new AbortController(),
      media: null,
      recorder: null,
    };
    recordingRef.current = active;
    // 工具栏即将隐藏, 把焦点留在始终可编辑的正文里.
    textareaRef.current?.el()?.focus();
    setVoiceInput({ kind: 'starting' });
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      active.media = media;
      // getUserMedia 不能用 AbortSignal 取消. 用户已取消或组件已卸载时, 立即关闭迟到的麦克风流.
      if (recordingRef.current !== active) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      const recorder = new MediaRecorder(media);
      active.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        media.getTracks().forEach(track => track.stop());
        if (recordingRef.current !== active) return;
        setVoiceInput({ kind: 'transcribing' });
        // 录音期间可以进入 Settings 修改绑定. 提交前读取当前值, 不使用开始录音时的旧值.
        if (!useProviderStore.getState().bindings.stt) {
          showToast('STT 模型已解绑, 本次录音未转写', { variant: 'warning' });
          recordingRef.current = null;
          setVoiceInput({ kind: 'idle' });
          return;
        }
        const audio = new Blob(chunks, { type: recorder.mimeType });
        chunks.length = 0;
        void providersApi.transcribe({ audio, mime: recorder.mimeType }, active.abort.signal)
          .then((result) => {
            if (recordingRef.current !== active) return;
            // 转写是异步的. 回来时必须追加到该 Session 的最新草稿, 不能用开始录音时闭包里的旧内容覆盖用户后续输入.
            const drafts = useChatDraftStore.getState();
            const latest = active.sessionId
              ? drafts.bySession.get(active.sessionId) ?? emptyChatDraft()
              : drafts.newSessionDraft;
            const next = {
              ...latest,
              text: `${latest.text}${result.text.trim()}`,
            };
            if (active.sessionId) drafts.setForSession(active.sessionId, next);
            else drafts.setForNewSession(next);
          })
          .catch((error) => {
            if (recordingRef.current !== active) return;
            showToast(
              error instanceof Error ? error.message : '语音转写失败',
              { variant: 'danger' },
            );
          })
          .finally(() => {
            if (recordingRef.current === active) {
              recordingRef.current = null;
              setVoiceInput({ kind: 'idle' });
            }
          });
      };
      recorder.start();
      setVoiceInput({ kind: 'recording', stream: media });
    } catch (error) {
      if (recordingRef.current !== active) return;
      recordingRef.current = null;
      releaseRecording(active);
      setVoiceInput({ kind: 'idle' });
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

  return (
    <div className="ema-composer-dock pointer-events-none shrink-0 px-4 pb-3 pt-6">
      <div className="ema-chat-content-column pointer-events-auto">
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
        <InputProjectBar sessionId={viewedId} session={viewedSession} projectId={currentProjectId} />
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
            disabled={compacting}
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
                <TtsButton
                  ttsEnabled={draft.ttsEnabled}
                  modelBound={ttsModelBound}
                  onToggle={options.toggleTts}
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
                  contextWindow={selectedModel?.capability === 'llm' ? selectedModel.contextWindow : undefined}
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
                      onClick={() => void startRecording()}
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
      {commandDialogs}
    </div>
  );
}
