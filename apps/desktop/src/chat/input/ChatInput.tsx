// 聊天输入主装配：有序输入段、命令/Skill、模型与 Session 下一轮设置。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { DropdownMenu, IconButton, PromptDialog, Textarea, type MenuItem, type TextareaHandle } from '@ema-agent/ui';
import { hasTurnInput, type TurnInputPart, type TurnModelSelection } from '@ema-agent/turn';
import { DecisionLayer } from '../../decision/DecisionLayer.js';
import { sessionsApi } from '../../api/sessions.js';
import { ServerApiError } from '../../api/client.js';
import { transcribeApi } from '../../api/transcribe.js';
import { showToast } from '../../lib/toast.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useServerStore } from '../../stores/server.js';
import { useSessionStore } from '../../stores/session.js';
import { useSkillStore } from '../../stores/skill.js';
import { useUiStore } from '../../stores/ui.js';
import { findEnabledModel, useProviderStore } from '../../stores/provider.js';
import { useCurrentSession } from '../state/currentSession.js';
import { useMessages } from '../state/messages.js';
import { sendMessage, stopStreaming } from '../state/turnRunner.js';
import { draftAttachmentTab, useDockTabs } from '../frame/dockTabs.js';
import { AttachmentChip } from '../messages/AttachmentChip.js';
import { useContextUsage } from '../state/contextUsage.js';
import { ContextMeter } from './ContextMeter.js';
import { ExecutionProfileSelector } from './ExecutionProfileSelector.js';
import { KbButton } from './KbScopePicker.js';
import { ModelPicker } from './ModelPicker.js';
import { NarrativePolicySelector } from './NarrativePolicySelector.js';
import { SlashCommandMenu, type SlashMenuHandle, type SlashSelection } from './SlashCommandMenu.js';
import { activeSlashToken } from './slashMenu.js';
import {
  draftText,
  insertDraftReference,
  removeDraftPart,
  replaceDraftText,
} from './composerDraft.js';

const COMPACT_ERRORS: Record<string, string> = {
  session_busy: '当前会话正忙，请稍后再试',
  compact_below_threshold: '历史还短，不需要压缩',
  nothing_to_compact: '没有可压缩的内容',
  provider_not_configured: '未配置可用模型',
  compact_failed: '压缩失败，请重试',
};

function attachmentFromPath(sourcePath: string): Extract<TurnInputPart, { type: 'attachment' }> {
  const name = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  const extension = name.split('.').pop()?.toLowerCase();
  const mimeType = extension === 'png' ? 'image/png'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'webp' ? 'image/webp'
    : extension === 'gif' ? 'image/gif'
    : extension === 'pdf' ? 'application/pdf'
    : extension === 'txt' || extension === 'md' ? 'text/plain'
    : undefined;
  return {
    type: 'attachment',
    attachment: { sourcePath, name, ...(mimeType ? { mimeType } : {}) },
  };
}

export function ChatInput(): JSX.Element {
  const viewedId = useCurrentSession(state => state.viewedSessionId);
  const savedDraft = useCurrentSession(state => viewedId ? state.draftMap.get(viewedId) : undefined);
  const viewedSession = useSessionStore(state => viewedId ? state.sessions.byId.get(viewedId) : undefined);
  const stream = useMessages(state => viewedId ? state.streamBySession.get(viewedId) : undefined);
  const hasOtherStream = useMessages(state => state.streamBySession.size > (stream ? 1 : 0));
  const serverReady = useServerStore(state => state.status.kind === 'ok');
  const ttsEnabled = useUiStore(state => state.ttsEnabled);
  const models = useProviderStore(state => state.models);
  const skills = useSkillStore(state => state.skills);

  const [parts, setPartsState] = useState<readonly TurnInputPart[]>(savedDraft ?? []);
  const [selectedAssetIds, setSelectedAssetIds] = useState<readonly string[]>([]);
  const [thinkingEffort, setThinkingEffort] = useState<TurnModelSelection['thinkingEffort']>('medium');
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const partsRef = useRef<readonly TurnInputPart[]>(parts);
  const textareaRef = useRef<TextareaHandle>(null);
  const slashMenuRef = useRef<SlashMenuHandle | null>(null);
  const previousSessionRef = useRef<string | null>(viewedId);

  const text = draftText(parts);
  const executionProfile = viewedSession?.executionProfile ?? 'chat';
  const narrativePolicy = viewedSession?.narrativePolicy ?? 'auto';
  const selectedModel = findEnabledModel(models, viewedSession?.providerId, viewedSession?.modelId);
  const selectedModelSupportsThinking = selectedModel?.capability === 'llm'
    && selectedModel.reasoning === true;
  const modelSelection: TurnModelSelection | null = viewedSession?.providerId && viewedSession.modelId
    ? {
        providerId: viewedSession.providerId,
        modelId: viewedSession.modelId,
        thinkingEnabled: selectedModelSupportsThinking && thinkingEnabled,
        thinkingEffort,
      }
    : null;

  const setParts = useCallback((next: readonly TurnInputPart[]) => {
    partsRef.current = next;
    setPartsState(next);
    if (viewedId) useCurrentSession.getState().setDraft(viewedId, next);
  }, [viewedId]);

  useEffect(() => {
    if (previousSessionRef.current === viewedId) return;
    previousSessionRef.current = viewedId;
    const next = viewedId ? useCurrentSession.getState().draftMap.get(viewedId) ?? [] : [];
    partsRef.current = next;
    setPartsState(next);
    setSelectedAssetIds([]);
    setSlashFilter(null);
    setThinkingEnabled(false);
    setThinkingEffort('medium');
  }, [viewedId]);

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
    const next = replaceDraftText(parts, nextText);
    setParts(next);
    const position = nextCaret ?? nextText.length;
    queueMicrotask(() => textareaRef.current?.el()?.setSelectionRange(position, position));
    setSlashFilter(activeSlashToken(nextText, position)?.query ?? null);
  }

  async function pickAttachments(): Promise<void> {
    const paths = await tauriBridge.openFileDialogMultiple();
    if (paths.length === 0) return;
    let next = parts;
    let offset = caret();
    for (const path of paths) {
      next = insertDraftReference(next, offset, attachmentFromPath(path));
    }
    setParts(next);
  }

  function openDraftAttachment(part: Extract<TurnInputPart, { type: 'attachment' }>): void {
    if (!viewedId) return;
    useDockTabs.getState().openTab(viewedId, draftAttachmentTab(part.attachment));
  }

  async function runCompact(): Promise<void> {
    if (!viewedId || compacting) return;
    setCompacting(true);
    try {
      const result = await sessionsApi.compact(viewedId);
      if (result.status === 'cancelled') showToast('压缩已取消', { variant: 'info' });
      else {
        useContextUsage.getState().applyManualCompact(
          viewedId,
          result.afterTokens,
          result.contextWindow,
        );
        showToast(`已压缩 ${result.beforeTokens} → ${result.afterTokens} tokens`, { variant: 'success' });
      }
      await useMessages.getState().reloadMessages(viewedId);
    } catch (error) {
      const code = error instanceof ServerApiError ? error.code : undefined;
      showToast(code && COMPACT_ERRORS[code]
        ? COMPACT_ERRORS[code]
        : error instanceof Error ? error.message : '压缩失败', { variant: 'danger' });
    } finally { setCompacting(false); }
  }

  async function runCommand(name: string): Promise<void> {
    const sessions = useSessionStore.getState();
    if (name === 'compact') return runCompact();
    if (name === 'new') {
      const id = await useCurrentSession.getState().createFreshSession();
      if (id) await useCurrentSession.getState().viewSession(id);
      return;
    }
    if (!viewedId) return;
    if (name === 'fork') {
      const id = await sessions.forkSession(viewedId);
      await useCurrentSession.getState().viewSession(id);
      return;
    }
    if (name === 'rename') { setRenameOpen(true); return; }
    if (name === 'pin') return sessions.pinSession(viewedId, !(viewedSession?.pinned ?? false));
    if (name === 'archive') return sessions.archiveSession(viewedId);
    showToast(`未知命令: /${name}`, { variant: 'warning' });
  }

  function selectSlash(selection: SlashSelection): void {
    const token = activeSlashToken(text, caret());
    if (!token) return;
    const withoutToken = text.slice(0, token.start) + text.slice(token.end);
    let next = replaceDraftText(parts, withoutToken);
    if (selection.kind === 'skill') {
      if (!next.some(part => part.type === 'skill' && part.skillKey === selection.skill.key)) {
        next = insertDraftReference(next, token.start, { type: 'skill', skillKey: selection.skill.key });
      }
      setParts(next);
    } else {
      setParts(next);
      void runCommand(selection.command.name).catch(error => showToast(
        error instanceof Error ? error.message : '命令执行失败', { variant: 'danger' },
      ));
    }
    setSlashFilter(null);
  }

  const send = useCallback(async () => {
    if (!hasTurnInput(parts) || !serverReady || stream || submitting || compacting) return;
    const submitted = parts;
    setSubmitting(true);
    try {
      await sendMessage(viewedId, {
        parts: submitted,
        executionProfile,
        narrativePolicy,
        ...(modelSelection ? { modelSelection } : {}),
        ...(executionProfile === 'work' && selectedAssetIds.length > 0
          ? { knowledgeAssetIds: [...selectedAssetIds] } : {}),
        ttsEnabled,
      });
      setPartsState(current => {
        if (current !== submitted) return current;
        if (viewedId) useCurrentSession.getState().setDraft(viewedId, []);
        partsRef.current = [];
        return [];
      });
      setSlashFilter(null);
    } catch (error) {
      showToast(error instanceof Error ? `发送失败: ${error.message}` : '发送失败', { variant: 'danger' });
    } finally { setSubmitting(false); }
  }, [parts, serverReady, stream, submitting, compacting, viewedId, executionProfile, narrativePolicy, modelSelection, selectedAssetIds, ttsEnabled]);

  async function toggleRecording(): Promise<void> {
    if (recording) { recorderRef.current?.stop(); return; }
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(mediaStream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
      recorder.onstop = () => {
        setRecording(false);
        mediaStream.getTracks().forEach(track => track.stop());
        const audio = new Blob(chunks, { type: recorder.mimeType });
        void transcribeApi.transcribe({ audio, mime: recorder.mimeType }).then(result => {
          const transcript = result.text.trim();
          if (!transcript) return;
          const currentParts = partsRef.current;
          const currentText = draftText(currentParts);
          const position = caret();
          const nextText = currentText.slice(0, position) + transcript + currentText.slice(position);
          const next = replaceDraftText(currentParts, nextText);
          setParts(next);
          queueMicrotask(() => textareaRef.current?.el()?.setSelectionRange(position + transcript.length, position + transcript.length));
        }).catch(error => showToast(error instanceof Error ? error.message : '语音转写失败', { variant: 'danger' }));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法使用麦克风', { variant: 'danger' });
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
    if (slashFilter !== null && ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
      if (slashMenuRef.current?.handleKey(event.key as 'ArrowUp' | 'ArrowDown' | 'Enter')) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === 'Escape' && slashFilter !== null) { setSlashFilter(null); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  }

  const plusItems: MenuItem[] = [
    { kind: 'item', label: '添加文件或图片', icon: 'i-lucide:paperclip', onSelect: () => void pickAttachments() },
    { kind: 'item', label: '选择技能', icon: 'i-lucide:box', onSelect: focusSlash },
    { kind: 'item', label: '运行命令', icon: 'i-lucide:terminal', onSelect: focusSlash },
  ];

  return (
    <div className="ema-composer-dock shrink-0 px-4 pb-3 pt-6">
      <div className="mx-auto max-w-3xl">
        <DecisionLayer />
        <div className="ema-composer-card relative transition-shadow">
          <SlashCommandMenu query={slashFilter} sessionId={viewedId} handleRef={slashMenuRef} onSelect={selectSlash} onClose={() => setSlashFilter(null)} />
          {parts.some(part => part.type !== 'text') && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3 pb-2">
              {parts.map((part, index) => {
                if (part.type === 'text') return null;
                if (part.type === 'attachment') return (
                  <AttachmentChip key={`${part.attachment.sourcePath}:${index}`} attachment={part.attachment} onOpen={() => openDraftAttachment(part)} onRemove={() => setParts(removeDraftPart(parts, index))} />
                );
                const name = skills.find(skill => skill.key === part.skillKey)?.name ?? part.skillKey;
                return (
                  <span key={`${part.skillKey}:${index}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--ema-border)] bg-[var(--ema-info-muted)] px-2 py-1 text-[11px] text-[var(--ema-info)]">
                    <span className="i-lucide:box text-xs" aria-hidden />{name}
                    <button type="button" className="i-lucide:x opacity-60 hover:opacity-100" aria-label={`移除技能 ${name}`} onClick={() => setParts(removeDraftPart(parts, index))} />
                  </span>
                );
              })}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            containerless
            autoGrow={false}
            rows={1}
            value={text}
            placeholder="随心输入，/ 打开命令与技能…"
            className="min-h-[64px] w-full resize-none overflow-y-auto rounded-[22px] bg-transparent px-4 py-3 text-sm text-[var(--ema-text-secondary)] focus:outline-none"
            style={{ maxHeight: 200 }}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              const position = event.target.selectionStart;
              updateText(event.target.value, position);
            }}
            onKeyDown={handleKeyDown}
            disabled={compacting}
          />
          <div className="flex min-w-0 items-center gap-1 border-t border-[var(--ema-border)] px-2 py-1.5">
            <DropdownMenu side="top" align="start" widthClass="min-w-48" items={plusItems} trigger={(
              <IconButton size="sm" variant="default" icon="i-lucide:plus" label="添加内容" />
            )} />
            <KbButton visible={executionProfile === 'work'} selectedIds={selectedAssetIds} onChange={setSelectedAssetIds} />
            <IconButton size="sm" variant={ttsEnabled ? 'primary' : 'default'} icon={ttsEnabled ? 'i-lucide:volume-2' : 'i-lucide:volume-x'} label="切换 TTS" toggled={ttsEnabled} onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)} />
            <NarrativePolicySelector value={narrativePolicy} onChange={policy => {
              if (viewedId) void useSessionStore.getState().setExecutionSettings(viewedId, { narrativePolicy: policy }).catch(error => showToast(error instanceof Error ? error.message : '保存剧情策略失败', { variant: 'danger' }));
            }} />
            <span className="min-w-2 flex-1" />
            <ContextMeter sessionId={viewedId} />
            <ExecutionProfileSelector value={executionProfile} onChange={profile => {
              if (viewedId) void useSessionStore.getState().setExecutionSettings(viewedId, { executionProfile: profile }).catch(error => showToast(error instanceof Error ? error.message : '保存模式失败', { variant: 'danger' }));
            }} />
            <ModelPicker selection={modelSelection} onChange={selection => {
              setThinkingEnabled(selection.thinkingEnabled);
              setThinkingEffort(selection.thinkingEffort);
              if (viewedId) void useSessionStore.getState().setPreferredModel(viewedId, { providerId: selection.providerId, modelId: selection.modelId }).catch(error => showToast(error instanceof Error ? error.message : '保存模型失败', { variant: 'danger' }));
            }} onClear={() => {
              setThinkingEnabled(false);
              if (viewedId) void useSessionStore.getState().setPreferredModel(viewedId, null).catch(error => showToast(error instanceof Error ? error.message : '恢复默认模型失败', { variant: 'danger' }));
            }} />
            <IconButton size="sm" variant={recording ? 'danger' : 'default'} icon={recording ? 'i-lucide:square' : 'i-lucide:mic'} label={recording ? '停止录音' : '语音输入'} onClick={() => void toggleRecording()} />
            {stream ? (
              <IconButton size="sm" variant="danger" icon="i-lucide:square" label="停止生成" onClick={() => { if (viewedId) stopStreaming(viewedId); }} />
            ) : (
              <IconButton size="sm" variant="primary" icon="i-lucide:arrow-up" label="发送" disabled={!hasTurnInput(parts) || !serverReady || submitting || compacting} onClick={() => void send()} />
            )}
          </div>
        </div>
        {hasOtherStream && <p className="mt-1 text-right text-[11px] text-[var(--ema-text-tertiary)]">其他会话正在生成</p>}
      </div>
      {renameOpen && viewedSession && <PromptDialog open title="重命名聊天" message="为当前聊天输入新标题。" initialValue={viewedSession.title ?? ''} placeholder="聊天标题" onConfirm={value => {
        setRenameOpen(false);
        if (viewedId && value.trim()) void useSessionStore.getState().renameSession(viewedId, value.trim());
      }} onCancel={() => setRenameOpen(false)} />}
    </div>
  );
}
