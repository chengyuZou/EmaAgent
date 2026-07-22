/**
 * DeleteTurnButton — 气泡底部的"删除此消息及后续内容"入口(级联删除)。
 *
 * 点击弹 ConfirmDialog(danger, 应用统一确认弹窗), 确认后调后端级联删除:
 * 目标 turn + 同分支后继 + 锚定其上的所有分支都会被删除, 不可恢复。
 * 删除后刷新分支数据与消息视图(active 可能已被后端回退)。
 *
 * 视觉与 ForkButton 一致: 默认隐入 hover 显出; streaming 气泡不显示(删除是完成态操作)。
 */
import { useState, type JSX } from 'react';
import { ConfirmDialog, IconButton } from '@ema-agent/ui';
import type { TurnId } from '@ema-agent/ids';
import { useConversationStore } from '../stores/conversation-store.js';
import { sessionsApi } from '../api/sessions.js';
import { SidecarApiError } from '../api/sidecar-client.js';
import { showToast } from '../lib/toast.js';

export function DeleteTurnButton({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedId = useConversationStore((s) => s.viewedSessionId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!viewedId) return null;

  const handleConfirm = async (): Promise<void> => {
    setConfirmOpen(false);
    setDeleting(true);
    try {
      const result = await sessionsApi.deleteTurn(viewedId, turnId as TurnId);
      // 分支结构可能已变(active 被回退) → 重载分支 + 清缓存重载消息。
      await useConversationStore.getState().loadBranches(viewedId);
      useConversationStore.setState((s) => {
        const m = new Map(s.messages);
        m.delete(viewedId as string);
        return { messages: m };
      });
      await useConversationStore.getState().loadMessages(viewedId);
      const branchPart = result.deletedBranchIds.length > 0
        ? `，${result.deletedBranchIds.length} 个分支`
        : '';
      showToast(`已删除 ${result.deletedTurnIds.length} 条消息${branchPart}`, { variant: 'success' });
    } catch (err) {
      if (err instanceof SidecarApiError && err.status === 409) {
        showToast('该轮正在生成中，请先停止再删除', { variant: 'warning' });
      } else {
        showToast(err instanceof Error ? `删除失败: ${err.message}` : '删除失败', { variant: 'danger' });
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <IconButton
        variant="default"
        size="sm"
        icon={deleting ? 'i-solar:spinner-bold animate-spin' : 'i-solar:trash-bin-2-bold'}
        label="删除此消息及后续内容"
        className="opacity-30 hover:opacity-80"
        disabled={deleting}
        onClick={() => setConfirmOpen(true)}
      />
      <ConfirmDialog
        open={confirmOpen}
        title="删除消息"
        message="此消息及其后的全部内容、以及从它们长出的分支都会被删除，不可恢复。确定删除？"
        confirmText="删除"
        danger
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
