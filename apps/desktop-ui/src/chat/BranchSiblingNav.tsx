/**
 * BranchSiblingNav — 分支兄弟导航器 ‹ N/M ›。
 *
 * 显示在 fork 点的子消息上（user + assistant 气泡统一），当该 fork 点有 ≥2 个兄弟分支时出现。
 * 点击 ‹/› 线性 prev/next 切换分支，统一走 store.switchBranchAndLoad，
 * 与 BranchPanel 节点点击共用同一动作 → 双向联动（图点节点 / 聊天切分支 互相更新）。
 *
 * 桌宠窗口无 viewedSessionId → 内部返回 null，自然不渲染。
 *
 * 注：‹ N/M › 用 raw <button> 是因为尺寸极小（w-3.5 h-3.5），@ema-agent/ui 的 Button 最小 h-7
 * 放不下胶囊；IconButton 无 children 放不下文字。样式全用 var(--ema-*) CSS 变量。
 */
import type { JSX } from 'react';
import { useConversationStore } from '../stores/conversation-store.js';

export function BranchSiblingNav({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedId   = useConversationStore((s) => s.viewedSessionId);
  const branchData = useConversationStore((s) =>
    viewedId ? s.branchDataBySession.get(viewedId as string) : undefined,
  );

  if (!branchData || !viewedId) return null;

  const siblings = branchData.branches
    .filter((b) => (b.forkFromTurnId as string) === turnId)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (siblings.length < 2) return null;

  const activeIdx = siblings.findIndex((b) => b.isActive);
  if (activeIdx < 0) return null;

  const pos   = activeIdx + 1;
  const total = siblings.length;

  const navigate = (delta: -1 | 1): void => {
    const next = siblings[activeIdx + delta];
    if (!next) return;
    void useConversationStore.getState().switchBranchAndLoad(viewedId, next.branchId);
  };

  return (
    <span className="flex items-center gap-0.5 ml-1 tabular-nums">
      <button
        className="w-3.5 h-3.5 flex items-center justify-center transition-colors leading-none disabled:opacity-25 disabled:pointer-events-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]"
        disabled={pos === 1}
        onClick={() => navigate(-1)}
        title="上一个分支"
      ><span className="i-mdi:chevron-left text-[10px]" aria-hidden /></button>
      <span className="text-[10px]" style={{ color: 'var(--ema-text-tertiary)' }}>{pos}/{total}</span>
      <button
        className="w-3.5 h-3.5 flex items-center justify-center transition-colors leading-none disabled:opacity-25 disabled:pointer-events-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]"
        disabled={pos === total}
        onClick={() => navigate(1)}
        title="下一个分支"
      ><span className="i-mdi:chevron-right text-[10px]" aria-hidden /></button>
    </span>
  );
}
