// 组装 Session 草稿、排队输入与输入区选择; 只有点击发送才创建 Session 并落盘附件.
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  DropdownMenu,
  IconButton,
  PromptDialog,
  Textarea,
  type MenuItem,
  type TextareaHandle,
} from '@ema-agent/ui';
import type { TurnInputPart, TurnModelSelection } from '@ema-agent/turn';
import { PASTE_TEXT_MIN_CHARS } from '@ema-agent/attachments/limits';
import { sessionsApi } from '../../api/sessions.js';
import { ServerApiError } from '../../api/client.js';
import { findAvailableModel, providersApi, type AvailableModel } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useAgentStore } from '../../stores/agent.js';
import { useServerStore } from '../../stores/server.js';
import { useSessionStore } from '../../stores/session.js';
import { useUiStore } from '../../stores/ui.js';
import { PendingInteractionView } from '../interactions/PendingInteractionView.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { useLiveTurns } from '../state/liveTurns.js';
import { ContextMeter, ExecutionProfileSelector, KbButton, ModelPicker, NarrativePolicySelector } from './InputSelectors.js';
import {
  activeSlashToken,
  SlashCommandMenu,
  type SlashMenuHandle,
  type SlashSelection,
} from './AddInputMenu.js';
import { draftText, emptyChatDraft, hasDraftContent, insertDraftReference, removeDraftPart, replaceDraftText, type ChatDraft, type ChatDraftPart } from './InputReferences.js';

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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('剪贴板图片读取失败'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function finalizeDraft(sessionId: string, parts: readonly ChatDraftPart[]): Promise<TurnInputPart[]> {
  const output: TurnInputPart[] = [];
  // 文件和长粘贴在草稿阶段只存在前端. 此处按用户原始顺序落盘, 成功后再入 Session 队列.
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'skill_reference') {
      output.push(part);
      continue;
    }
    if (part.type === 'file') {
      output.push({
        type: 'attachment',
        block: { type: 'file_reference', path: part.path },
      });
      continue;
    }
    if (part.type === 'pasted_text') {
      const saved = await sessionsApi.createPastedText(sessionId, part.content);
      output.push({
        type: 'attachment',
        block: {
          type: 'pasted_text_reference',
          path: saved.path,
          preview: saved.preview,
        },
      });
      continue;
    }
    const name = part.name ?? part.sourcePath?.split(/[\\/]/).pop();
    const saved = part.file
      ? await sessionsApi.uploadImage(sessionId, {
          dataBase64: await fileToBase64(part.file),
          ...(name ? { name } : {}),
        })
      : await sessionsApi.uploadImage(sessionId, {
          sourcePath: part.sourcePath!,
          ...(name ? { name } : {}),
        });
    output.push({
      type: 'attachment',
      block: {
        type: 'image_reference',
        path: saved.path,
        ...(name ? { name } : {}),
      },
    });
  }
  return output;
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

export function ChatInput(): JSX.Element {
  const viewedId = useChatWorkspace(state => state.viewedSessionId);
  const newProjectId = useChatWorkspace(state => state.newSessionProjectId);
  const storedDraft = useChatWorkspace(state => viewedId ? state.draftMap.get(viewedId) : state.newSessionDraft);
  const viewedSession = useSessionStore(state => viewedId ? state.sessions.byId.get(viewedId) : undefined);
  const agentSession = useAgentStore(state => viewedId ? state.sessions.get(viewedId) : undefined);
  const serverReady = useServerStore(state => state.status.kind === 'ok');
  const ttsEnabled = useUiStore(state => state.ttsEnabled);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<TextareaHandle>(null);
  const slashMenuRef = useRef<SlashMenuHandle | null>(null);

  const draft: ChatDraft = storedDraft ?? {
    ...emptyChatDraft(),
    executionProfile: viewedSession?.executionProfile ?? 'chat',
    narrativePolicy: viewedSession?.narrativePolicy ?? 'auto',
    ...(viewedSession?.providerId && viewedSession.modelId
      ? {
          modelSelection: {
            providerId: viewedSession.providerId,
            modelId: viewedSession.modelId,
            thinkingEnabled: false,
            thinkingEffort: 'medium' as const,
          },
        }
      : {}),
  };
  const text = draftText(draft.parts);
  const hasInput = hasDraftContent(draft.parts);
  const executing = agentSession?.execution != null;
  const selectedModel = findAvailableModel(models, draft.modelSelection?.providerId, draft.modelSelection?.modelId);
  const modelSelection: TurnModelSelection | undefined = draft.modelSelection ? {
    ...draft.modelSelection,
    thinkingEnabled: selectedModel?.capability === 'llm' && selectedModel.reasoning === true && draft.modelSelection.thinkingEnabled,
  } : undefined;

  function updateDraft(patch: Partial<ChatDraft>): void {
    useChatWorkspace.getState().setDraft({ ...draft, ...patch });
  }

  useEffect(() => {
    providersApi.listAvailable('llm').then(({ models: items }) => setModels([...items])).catch(() => {});
  }, []);
  useEffect(() => {
    if (viewedId && serverReady) useAgentStore.getState().connectSession(viewedId);
  }, [serverReady, viewedId]);
  useEffect(() => {
    const element = textareaRef.current?.el();
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function caret(): number {
    return textareaRef.current?.el()?.selectionStart ?? text.length;
  }
  function updateText(nextText: string, nextCaret?: number): void {
    updateDraft({ parts: replaceDraftText(draft.parts, nextText) });
    const position = nextCaret ?? nextText.length;
    queueMicrotask(() => textareaRef.current?.el()?.setSelectionRange(position, position));
    setSlashFilter(activeSlashToken(nextText, position)?.query ?? null);
  }

  async function pickAttachments(): Promise<void> {
    const paths = await tauriBridge.openFileDialogMultiple();
    let next = draft.parts;
    for (const sourcePath of paths) {
      next = insertDraftReference(
        next,
        caret(),
        isLlmImagePath(sourcePath)
          ? { type: 'image', sourcePath, name: sourcePath.split(/[\\/]/).pop() }
          : { type: 'file', path: sourcePath },
      );
    }
    updateDraft({ parts: next });
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const image = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      updateDraft({
        parts: insertDraftReference(draft.parts, caret(), {
          type: 'image',
          file: image,
          name: image.name || undefined,
        }),
      });
      return;
    }
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (pasted.length >= PASTE_TEXT_MIN_CHARS) {
      event.preventDefault();
      updateDraft({
        parts: insertDraftReference(draft.parts, caret(), {
          type: 'pasted_text',
          content: pasted,
          preview: `${pasted.slice(0, 120)}${pasted.length > 120 ? '…' : ''}`,
        }),
      });
    }
  }

  async function runCompact(): Promise<void> {
    if (!viewedId || compacting) return;
    setCompacting(true);
    try {
      const result = await useAgentStore.getState().startCompaction(viewedId);
      if (result.status === 'cancelled') {
        showToast('压缩已取消', { variant: 'info' });
      } else {
        useLiveTurns.getState().applyManualCompact(viewedId, result.afterTokens, result.contextWindow);
        showToast(`已压缩 ${result.beforeTokens} → ${result.afterTokens} tokens`, { variant: 'success' });
      }
    } catch (error) {
      const code = error instanceof ServerApiError ? error.code : undefined;
      showToast(
        code && COMPACT_ERRORS[code]
          ? COMPACT_ERRORS[code]
          : error instanceof Error
            ? error.message
            : '压缩失败',
        { variant: 'danger' },
      );
    } finally {
      setCompacting(false);
    }
  }

  async function runCommand(name: string): Promise<void> {
    const sessions = useSessionStore.getState();
    if (name === 'compact') return runCompact();
    if (name === 'new') {
      useChatWorkspace.getState().openNewSession();
      return;
    }
    if (!viewedId) return;
    if (name === 'fork') {
      await useChatWorkspace.getState().viewSession(await sessions.forkSession(viewedId));
      return;
    }
    if (name === 'rename') {
      setRenameOpen(true);
      return;
    }
    if (name === 'pin') return sessions.pinSession(viewedId, !(viewedSession?.pinned ?? false));
    if (name === 'archive') return sessions.archiveSession(viewedId);
    showToast(`未知命令: /${name}`, { variant: 'warning' });
  }

  function selectSlash(selection: SlashSelection): void {
    const token = activeSlashToken(text, caret());
    if (!token) return;
    let next = replaceDraftText(draft.parts, text.slice(0, token.start) + text.slice(token.end));
    if (
      selection.kind === 'skill'
      && !next.some((part) => (
        part.type === 'skill_reference' && part.path === selection.skill.path
      ))
    ) {
      next = insertDraftReference(next, token.start, {
        type: 'skill_reference',
        name: selection.skill.name,
        path: selection.skill.path,
      });
    }
    updateDraft({ parts: next });
    setSlashFilter(null);
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
    setSubmitting(true);
    let sessionId = viewedId;
    try {
      if (!sessionId) {
        sessionId = await useSessionStore.getState().createSession({
          ...(newProjectId ? { projectId: newProjectId } : {}),
          executionProfile: submitted.executionProfile,
          narrativePolicy: submitted.narrativePolicy,
        });
        useChatWorkspace.getState().promoteNewSession(sessionId);
      }
      useAgentStore.getState().connectSession(sessionId);
      const input = await finalizeDraft(sessionId, submitted.parts);
      await useAgentStore.getState().enqueueInput(sessionId, {
        input,
        executionProfile: submitted.executionProfile,
        narrativePolicy: submitted.narrativePolicy,
        ...(modelSelection ? { modelSelection } : {}),
        ...(submitted.executionProfile === 'work' && submitted.selectedAssetIds.length > 0
          ? { knowledge: { assetIds: [...submitted.selectedAssetIds] } }
          : {}),
        ttsEnabled,
      });
      const current = useChatWorkspace.getState().draftMap.get(sessionId);
      if (current === submitted || (!viewedId && current?.parts === submitted.parts)) {
        useChatWorkspace.getState().setDraft({ ...submitted, parts: [] });
      }
      setSlashFilter(null);
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
            const workspace = useChatWorkspace.getState();
            const latest = recordingSessionId
              ? workspace.draftMap.get(recordingSessionId) ?? emptyChatDraft()
              : workspace.newSessionDraft;
            workspace.setDraftFor(recordingSessionId, {
              ...latest,
              parts: replaceDraftText(
                latest.parts,
                `${draftText(latest.parts)}${result.text.trim()}`,
              ),
            });
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

  function focusSlash(): void {
    const position = caret();
    const prefix = position === 0 || /\s/.test(text[position - 1] ?? '') ? '/' : ' /';
    updateText(text.slice(0, position) + prefix + text.slice(position), position + prefix.length);
    textareaRef.current?.el()?.focus();
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

  const plusItems: MenuItem[] = [
    {
      kind: 'item',
      label: '添加文件或图片',
      icon: 'i-lucide:paperclip',
      onSelect: () => void pickAttachments(),
    },
    { kind: 'item', label: '选择技能', icon: 'i-lucide:box', onSelect: focusSlash },
    { kind: 'item', label: '运行命令', icon: 'i-lucide:terminal', onSelect: focusSlash },
  ];

  return (
    <div className="ema-composer-dock shrink-0 px-4 pb-3 pt-6">
      <div className="mx-auto max-w-3xl">
        <PendingInteractionView />
        {agentSession && agentSession.queuedInputs.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            {agentSession.queuedInputs.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-2 text-xs"
              >
                <span className="i-lucide:clock-3 text-[var(--ema-text-tertiary)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[var(--ema-text-secondary)]">
                  {queuedInputText(item.input)}
                </span>
                {item.delivery === 'after_turn' && executing && (
                  <button
                    className="text-[var(--ema-primary)] hover:underline"
                    onClick={() => void useAgentStore.getState().guideQueuedInput(viewedId!, item.id)}
                  >
                    立即引导
                  </button>
                )}
                <IconButton
                  size="sm"
                  icon="i-lucide:x"
                  label="删除排队输入"
                  onClick={() => void useAgentStore.getState().removeQueuedInput(viewedId!, item.id)}
                />
              </div>
            ))}
          </div>
        )}
        <div className="ema-composer-card relative transition-shadow">
          <SlashCommandMenu
            query={slashFilter}
            sessionId={viewedId}
            handleRef={slashMenuRef}
            onSelect={selectSlash}
            onClose={() => setSlashFilter(null)}
          />
          {draft.parts.some(part => part.type !== 'text') && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2 pt-3">
              {draft.parts.map((part, index) => part.type === 'text' ? null : (
                <span
                  key={index}
                  className="inline-flex max-w-52 items-center gap-1 rounded-md border border-[var(--ema-border)] bg-[var(--ema-info-muted)] px-2 py-1 text-[11px] text-[var(--ema-info)]"
                >
                  <span
                    className={part.type === 'skill_reference'
                      ? 'i-lucide:box'
                      : part.type === 'image'
                        ? 'i-lucide:image'
                        : 'i-lucide:paperclip'}
                    aria-hidden
                  />
                  <span className="truncate">
                    {part.type === 'skill_reference'
                      ? part.name
                      : part.type === 'file'
                        ? part.path.split(/[\\/]/).pop()
                        : part.type === 'pasted_text'
                          ? part.preview
                          : part.name ?? '图片'}
                  </span>
                  <button
                    type="button"
                    className="i-lucide:x opacity-60 hover:opacity-100"
                    aria-label="移除"
                    onClick={() => updateDraft({
                      parts: removeDraftPart(draft.parts, index),
                    })}
                  />
                </span>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            containerless
            autoGrow={false}
            rows={1}
            value={text}
            placeholder="随心输入, / 打开命令与技能…"
            className="min-h-[64px] w-full resize-none overflow-y-auto rounded-[22px] bg-transparent px-4 py-3 text-sm text-[var(--ema-text-secondary)] focus:outline-none"
            style={{ maxHeight: 200 }}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => (
              updateText(event.target.value, event.target.selectionStart)
            )}
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
                  variant="default"
                  icon="i-lucide:plus"
                  label="添加内容"
                  className="rounded-full"
                />
              )}
            />
            <KbButton
              visible={draft.executionProfile === 'work'}
              selectedIds={draft.selectedAssetIds}
              onChange={(selectedAssetIds) => updateDraft({ selectedAssetIds })}
            />
            <IconButton
              size="sm"
              variant={ttsEnabled ? 'primary' : 'default'}
              icon={ttsEnabled ? 'i-lucide:volume-2' : 'i-lucide:volume-x'}
              label="切换 TTS"
              toggled={ttsEnabled}
              onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)}
            />
            <NarrativePolicySelector
              value={draft.narrativePolicy}
              onChange={(narrativePolicy) => {
                updateDraft({ narrativePolicy });
                if (viewedId) {
                  void useSessionStore.getState().setExecutionSettings(
                    viewedId,
                    { narrativePolicy },
                  );
                }
              }}
            />
            <span className="min-w-2 flex-1" />
            <ContextMeter sessionId={viewedId} />
            <ExecutionProfileSelector
              value={draft.executionProfile}
              onChange={(executionProfile) => {
                updateDraft({ executionProfile });
                if (viewedId) {
                  void useSessionStore.getState().setExecutionSettings(
                    viewedId,
                    { executionProfile },
                  );
                }
              }}
            />
            <ModelPicker
              selection={modelSelection ?? null}
              onChange={(selection) => {
                updateDraft({ modelSelection: selection });
                if (viewedId) {
                  void useSessionStore.getState().setPreferredModel(viewedId, {
                    providerId: selection.providerId,
                    modelId: selection.modelId,
                  });
                }
              }}
              onClear={() => {
                updateDraft({ modelSelection: undefined });
                if (viewedId) {
                  void useSessionStore.getState().setPreferredModel(viewedId, null);
                }
              }}
            />
            <IconButton
              size="sm"
              variant={recording ? 'danger' : 'default'}
              icon={recording ? 'i-lucide:square' : 'i-lucide:mic'}
              label={recording ? '停止录音' : '语音输入'}
              onClick={() => void toggleRecording()}
            />
            {executing && !hasInput ? (
              <IconButton
                size="sm"
                variant="danger"
                icon="i-lucide:square"
                label="停止生成"
                onClick={() => {
                  if (viewedId) void useAgentStore.getState().cancelExecution(viewedId);
                }}
              />
            ) : (
              <IconButton
                size="sm"
                variant="primary"
                icon="i-lucide:arrow-up"
                label={executing ? '加入队列' : '发送'}
                disabled={!hasInput || !serverReady || submitting || compacting}
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
