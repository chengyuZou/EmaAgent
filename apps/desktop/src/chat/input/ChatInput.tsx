// 聊天输入主装配:草稿、附件、发送与工具栏,KB 选择器与工作区按钮各自成文件。
import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type JSX, type ChangeEvent } from 'react';
import { IconButton, Textarea, type TextareaHandle, Switch } from '@ema-agent/ui';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useSessionStore } from '../../stores/session-store.js';
import { useUiStore } from '../../stores/ui-store.js';
import { useServerStore } from '../../stores/server-store.js';
import { ExecutionProfileSelector } from './ExecutionProfileSelector.js';
import { DecisionLayer } from '../../decision/DecisionLayer.js';
import { ModelPicker, type ModelSelection } from './ModelPicker.js';
import { findEnabledModel, useModelCatalogStore } from '../../stores/model-catalog-store.js';
import { AttachmentChip } from '../messages/AttachmentChip.js';
import { showToast } from '../../lib/toast.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { filePathToAttachment, type PendingAttachment } from './attachmentInput.js';
import { KbButton } from './KbScopePicker.js';
import { WorkspaceButton } from './WorkspaceButton.js';

export function ChatInput(): JSX.Element {
  const viewedId   = useConversationStore((s) => s.viewedSessionId);
  const ttsEnabled = useUiStore((s) => s.ttsEnabled);
  const serverReady = useServerStore((s) => s.status.kind === 'ok');

  const initialDraft = useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '';
  const [text, setText] = useState(initialDraft);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Map<kbId, assetId[]> — per-KB doc selection; persists when switching library tabs.
  const [selectedScopes,   setSelectedScopes]   = useState<Map<string, string[]>>(new Map());
  const [thinkingEnabled,  setThinkingEnabled]  = useState(false);
  const textareaRef     = useRef<TextareaHandle>(null);
  const prevViewedIdRef = useRef(viewedId);
  const invalidModelCleanupRef = useRef<string | null>(null);
  const TEXTAREA_MAX_H  = 200; // px — beyond this the textarea scrolls

  const viewedSession = useSessionStore((state) =>
    viewedId ? state.sessions.byId.get(viewedId as string) : undefined,
  );
  const modelCatalog = useModelCatalogStore((state) => state.models);
  const modelCatalogStatus = useModelCatalogStore((state) => state.status);
  const selectedModelDefinition = findEnabledModel(
    modelCatalog,
    viewedSession?.providerId,
    viewedSession?.modelId,
  );
  const selectedModel: ModelSelection | null =
    viewedSession?.providerId && viewedSession.modelId
      ? {
          providerId: viewedSession.providerId,
          model: viewedSession.modelId,
          // 可用模型是能力联合，reasoning 只在 llm 成员上存在（目录本就只加载 llm）。
          reasoning: selectedModelDefinition?.capability === 'llm'
            ? selectedModelDefinition.reasoning ?? undefined
            : undefined,
        }
      : null;

  useEffect(() => {
    if (prevViewedIdRef.current === viewedId) return;
    prevViewedIdRef.current = viewedId;
    setText(useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '');
    setSelectedScopes(new Map()); // KB selection is per-session; reset when switching sessions
    setThinkingEnabled(false);
  }, [viewedId]);

  // 目录成功加载后才清理已失效选择；网络失败不能误删用户的持久化偏好。
  useEffect(() => {
    if (modelCatalogStatus !== 'ready' || !viewedId) return;
    const providerConfigId = viewedSession?.providerId;
    const modelId = viewedSession?.modelId;
    if (!providerConfigId || !modelId) {
      invalidModelCleanupRef.current = null;
      return;
    }
    if (selectedModelDefinition) {
      invalidModelCleanupRef.current = null;
      return;
    }

    const invalidKey = `${viewedId}:${providerConfigId}:${modelId}`;
    if (invalidModelCleanupRef.current === invalidKey) return;
    invalidModelCleanupRef.current = invalidKey;

    void useSessionStore.getState().setPreferredModel(viewedId, null).catch((error: unknown) => {
      showToast(
        error instanceof Error ? `清理失效模型失败: ${error.message}` : '清理失效模型失败',
        { variant: 'danger' },
      );
    });
  }, [
    modelCatalogStatus,
    selectedModelDefinition,
    viewedId,
    viewedSession?.modelId,
    viewedSession?.providerId,
  ]);

  // Auto-resize textarea height based on content, capped at TEXTAREA_MAX_H.
  useEffect(() => {
    const el = textareaRef.current?.el();
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_H)}px`;
  }, [text]);

  const executionProfile = viewedSession?.executionProfile ?? 'chat';
  const narrativePolicy = viewedSession?.narrativePolicy ?? 'auto';

  const hasAnyStreaming  = useConversationStore((s) => s.streamingMap.size > 0);
  const isStreamingHere = useConversationStore((s) =>
    viewedId ? s.streamingMap.has(viewedId as string) : false,
  );
  // 附件-only 也可发送（后端 turns.ts refine 同步放行）
  const canSend = (text.trim().length > 0 || pendingAttachments.length > 0)
    && serverReady
    && !isStreamingHere
    && !isSubmitting;

  function handleChange(value: string): void {
    setText(value);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, value);
  }

  // 多选文件：原生选框直接返回绝对路径，元数据由 Server realpath/stat 权威化。
  async function pickAttachment(): Promise<void> {
    const paths = await tauriBridge.openFileDialogMultiple();
    if (paths.length === 0) return;
    const atts = paths.map(filePathToAttachment);
    if (atts.length === 0) {
      showToast('所选文件不可用', { variant: 'warning' });
      return;
    }
    setPendingAttachments((prev) => [...prev, ...atts]);
  }

  function removeAttachment(id: string): void {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const send = useCallback(async (): Promise<void> => {
    if (!canSend) return;
    const submittedText = text;
    const submittedAttachments = [...pendingAttachments];
    const submittedAttachmentIds = new Set(submittedAttachments.map((attachment) => attachment.id));
    setIsSubmitting(true);

    try {
      await useConversationStore.getState().sendMessage(viewedId, {
        executionProfile,
        narrativePolicy,
        text: submittedText.trim(),
        attachments: submittedAttachments.length > 0 ? submittedAttachments : undefined,
        // 模型身份与推理配置同生同灭；V1 只有布尔思考开关，统一映射到 medium 档。
        ...(selectedModel
          ? {
              modelSelection: {
                providerId: selectedModel.providerId,
                modelId: selectedModel.model,
                thinkingEnabled,
                thinkingEffort: 'medium' as const,
              },
            }
          : {}),
        ttsEnabled,
        // KB scope applies to Work only. Selection persists across sends.
        ...(() => {
          if (executionProfile !== 'work' || selectedScopes.size === 0) return {};
          const assetIds = [...selectedScopes.values()].flat();
          if (assetIds.length === 0) return {};
          return { knowledgeAssetIds: assetIds };
        })(),
      });

      setText((current) => current === submittedText ? '' : current);
      setPendingAttachments((current) => current.filter(
        (attachment) => !submittedAttachmentIds.has(attachment.id),
      ));
      if (viewedId) {
        const store = useConversationStore.getState();
        if (store.draftMap.get(viewedId as string) === submittedText) {
          store.setDraft(viewedId, '');
        }
      }
    } catch (err) {
      showToast(
        err instanceof Error ? `发送失败: ${err.message}` : '发送失败，请重试',
        { variant: 'danger' },
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSend,
    executionProfile,
    narrativePolicy,
    text,
    pendingAttachments,
    selectedModel,
    ttsEnabled,
    thinkingEnabled,
    viewedId,
    selectedScopes,
  ]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // The send/stop button rendered inside the Textarea's embeddedAction slot.
  const embeddedAction = isStreamingHere ? (
    <IconButton
      variant="danger"
      size="sm"
      label="停止生成"
      icon="i-lucide:square"
      onClick={() => { if (viewedId) useConversationStore.getState().stopStreaming(viewedId); }}
    />
  ) : (
    <IconButton
      variant="primary"
      size="sm"
      label="发送"
      icon="i-lucide:send"
      onClick={() => void send()}
    />
  );

  return (
    <div className="shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--ema-border)' }}>
      <div className="max-w-2xl mx-auto">
        <DecisionLayer />

        {/* ── Unified input box ── */}
        <div
          className="relative rounded-2xl transition-shadow bg-[var(--ema-surface-2)]"
        >
          {/* Attachment strip (top half, shown only when files queued) */}
          {pendingAttachments.length > 0 && (
            <>
              <div className="relative px-3 pt-3 pb-2 flex flex-wrap gap-1.5">
                {pendingAttachments.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    attachment={a}
                    onRemove={() => removeAttachment(a.id)}
                  />
                ))}
              </div>
              {/* Fully transparent divider — just a hairline to separate regions */}
              <div className="mx-4 border-t border-[var(--ema-border)]" />
            </>
          )}

          {/* Textarea + send button (bottom half) */}
          <Textarea
            containerless
            autoGrow={false}
            ref={textareaRef}
            className="w-full bg-transparent rounded-2xl px-4 py-3 pr-12 text-sm resize-none focus:outline-none overflow-y-auto min-h-[60px] text-[var(--ema-text-secondary)]"
            style={{ maxHeight: TEXTAREA_MAX_H }}
            rows={1}
            placeholder="输入消息…"
            value={text}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            embeddedAction={embeddedAction}
          />
        </div>

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            <WorkspaceButton sessionId={viewedId as string | null} />

            {/* Attachment picker */}
            <div className="relative">
              <IconButton
                variant={pendingAttachments.length > 0 ? 'primary' : 'default'}
                size="sm"
                label="添加附件"
                icon="i-lucide:paperclip"
                toggled={pendingAttachments.length > 0}
                onClick={() => void pickAttachment()}
              />
              {pendingAttachments.length > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none bg-[var(--ema-primary)] text-[var(--ema-text-primary)]">
                  {pendingAttachments.length}
                </span>
              )}
            </div>

            <KbButton
              visible={executionProfile === 'work'}
              selectedScopes={selectedScopes}
              onScopesChange={setSelectedScopes}
            />

            <IconButton
              variant={ttsEnabled ? 'primary' : 'default'}
              size="sm"
              label="切换 TTS"
              icon="i-lucide:volume-2"
              toggled={ttsEnabled}
              onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)}
            />

            <ModelPicker
              selected={selectedModel}
              onSelect={(sel) => {
                if (viewedId) {
                  void useSessionStore.getState().setPreferredModel(viewedId, {
                    providerId: sel.providerId,
                    modelId: sel.model,
                  }).catch((error: unknown) => {
                    showToast(
                      error instanceof Error ? `保存模型失败: ${error.message}` : '保存模型失败',
                      { variant: 'danger' },
                    );
                  });
                }
                if (!sel.reasoning) setThinkingEnabled(false);
              }}
              onClear={() => {
                if (viewedId) {
                  void useSessionStore.getState().setPreferredModel(viewedId, null).catch((error: unknown) => {
                    showToast(
                      error instanceof Error ? `恢复默认模型失败: ${error.message}` : '恢复默认模型失败',
                      { variant: 'danger' },
                    );
                  });
                }
                setThinkingEnabled(false);
              }}
            />

            {/* 启用思考 — 仅当所选模型支持思考时显示 */}
            {selectedModel?.reasoning && (
              <div className="flex items-center gap-1 px-1 ema-fade-in">
                <Switch
                  checked={thinkingEnabled}
                  onCheckedChange={setThinkingEnabled}
                  label="启用思考"
                />
                <span className="text-[11px] select-none text-[var(--ema-text-tertiary)]">
                  思考
                </span>
              </div>
            )}

            <ExecutionProfileSelector
              executionProfile={executionProfile}
              narrativePolicy={narrativePolicy}
              onExecutionProfileChange={(profile) => {
                if (!viewedId) return;
                void useSessionStore.getState()
                  .setExecutionSettings(viewedId, { executionProfile: profile })
                  .catch((error: unknown) => {
                    showToast(
                      error instanceof Error ? `保存模式失败: ${error.message}` : '保存模式失败',
                      { variant: 'danger' },
                    );
                  });
              }}
              onNarrativePolicyChange={(policy) => {
                if (!viewedId) return;
                void useSessionStore.getState()
                  .setExecutionSettings(viewedId, { narrativePolicy: policy })
                  .catch((error: unknown) => {
                    showToast(
                      error instanceof Error ? `保存剧情策略失败: ${error.message}` : '保存剧情策略失败',
                      { variant: 'danger' },
                    );
                  });
              }}
            />
          </div>

          {hasAnyStreaming && (
            <div className="text-xs flex items-center gap-1.5 text-[var(--ema-text-tertiary)]">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-[var(--ema-primary)]" aria-hidden />
              {isStreamingHere ? '生成中…' : '其他会话生成中'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
