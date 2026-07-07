/**
 * BranchPanel — interactive turn-level branch tree for the current session.
 *
 * Each node = one turn. Turns on the same branch form a vertical chain;
 * forks diverge to a new column at the fork point. Click a node → switch
 * to that turn's branch + scroll chat to that turn.
 *
 * Layout: top-down. Top = oldest turn, bottom = newest. Forks branch right.
 *
 * Interactions:
 *   - Mouse drag  → pan
 *   - Scroll wheel → zoom (centered on cursor)
 *   - Click node   → switch to that turn's branch + scroll ChatHistory to it
 */
import { useState, useEffect, useRef, useCallback, type JSX } from 'react';
import type { BranchId, TurnMode } from '@ema-agent/contracts';
import { Button } from '@ema-agent/ui';
import { sessionsApi, type BranchNodeWire, type TurnTreeNodeWire } from '../api/sessions.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { showToast } from '../lib/toast.js';

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W   = 160;   // horizontal distance between branch columns
const NODE_H   = 80;    // vertical distance between turns
const NODE_R   = 20;    // node circle radius
const LABEL_W  = 130;   // max label width in px

// ── Types ─────────────────────────────────────────────────────────────────────

interface NodePos { x: number; y: number }

// ── Turn-level layout algorithm ───────────────────────────────────────────────

function buildTurnLayout(
  branches: BranchNodeWire[],
  turns:    TurnTreeNodeWire[],
): Map<string, NodePos> {
  if (turns.length === 0) return new Map();

  // No branches — all turns on the implicit main line, single column
  if (branches.length === 0) {
    const pos = new Map<string, NodePos>();
    const sorted = [...turns].sort((a, b) => a.startedAt - b.startedAt);
    sorted.forEach((t, i) => {
      pos.set(t.id as string, { x: NODE_W / 2, y: i * NODE_H + NODE_R + 8 });
    });
    return pos;
  }

  // Build branch tree (parent → children)
  const childrenOf = new Map<string | null, string[]>();
  for (const b of branches) {
    const p = b.parentBranchId as string | null;
    const list = childrenOf.get(p) ?? [];
    list.push(b.branchId as string);
    childrenOf.set(p, list);
  }

  // Group + sort turns by branch
  const turnsByBranch = new Map<string, TurnTreeNodeWire[]>();
  for (const t of turns) {
    const bid = (t.branchId ?? '__null__') as string;
    const list = turnsByBranch.get(bid) ?? [];
    list.push(t);
    turnsByBranch.set(bid, list);
  }
  for (const list of turnsByBranch.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  // Assign columns (x) to branches — leaf-counting post-order, center internal
  const branchX = new Map<string, number>();
  let leafCounter = 0;
  function assignX(id: string): void {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) { branchX.set(id, leafCounter++); return; }
    for (const kid of kids) assignX(kid);
    const first = branchX.get(kids[0]!)!;
    const last  = branchX.get(kids[kids.length - 1]!)!;
    branchX.set(id, (first + last) / 2);
  }
  const roots = branches.filter((b) => b.parentBranchId === null).map((b) => b.branchId as string);
  for (const root of roots) assignX(root);

  // Place turns: chain within branch, fork-aligned y
  const pos = new Map<string, NodePos>();
  function placeBranch(branchId: string): void {
    const x = (branchX.get(branchId) ?? 0) * NODE_W + NODE_W / 2;
    const branchRow = branches.find((b) => (b.branchId as string) === branchId);
    const forkTurnId = branchRow?.forkFromTurnId as string | null;
    const forkPos = forkTurnId ? pos.get(forkTurnId) : undefined;
    let y = forkPos ? forkPos.y + NODE_H : NODE_R + 8;
    for (const t of turnsByBranch.get(branchId) ?? []) {
      pos.set(t.id as string, { x, y });
      y += NODE_H;
    }
    for (const kid of childrenOf.get(branchId) ?? []) placeBranch(kid);
  }
  for (const root of roots) placeBranch(root);

  // Center horizontally
  const xs = [...pos.values()].map((p) => p.x);
  if (xs.length > 0) {
    const minX = Math.min(...xs);
    for (const [id, p] of pos) pos.set(id, { x: p.x - minX + NODE_W / 2, y: p.y });
  }

  return pos;
}

// ── Mode icon + color ─────────────────────────────────────────────────────────

function ModeIcon({ mode }: { mode: TurnMode | null }): JSX.Element {
  const icon =
    mode === 'agent'     ? 'i-mdi:robot-outline' :
    mode === 'narrative' ? 'i-mdi:book-open-variant-outline' :
                           'i-mdi:chat-outline';
  return <span className={`${icon} text-sm`} aria-hidden />;
}

function modeColor(mode: TurnMode | null): string {
  if (mode === 'agent')     return 'var(--ema-info)';
  if (mode === 'narrative') return 'var(--ema-warning)';
  return                           'var(--ema-primary)';
}

// ── BranchPanel ───────────────────────────────────────────────────────────────

export function BranchPanel(): JSX.Element {
  const sessionId = useConversationStore((s) => s.viewedSessionId);
  // active 订阅 branchDataBySession —— BranchSiblingNav 切换时 branchData 更新，这里自动联动高亮。
  const branchData = useConversationStore((s) =>
    sessionId ? s.branchDataBySession.get(sessionId as string) : undefined,
  );
  const active = branchData?.sessionActiveBranchId as string | null ?? null;

  const [branches, setBranches] = useState<BranchNodeWire[]>([]);
  const [turns, setTurns]       = useState<TurnTreeNodeWire[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // Pan + zoom state
  const [pan,  setPan]  = useState({ x: 0, y: 20 });
  const [zoom, setZoom] = useState(1);
  const dragging  = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await sessionsApi.listBranches(sessionId);
      setBranches(data.branches);
      setTurns(data.turns);
      // active 不再本地存 —— 从 branchDataBySession 派生（switchBranchAndLoad 会更新它）
    } catch {
      setError('加载分支失败');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  // ── Pan handlers ────────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setAttribute('data-dragging', '1');
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onUp = (): void => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',  onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',  onUp);
    };
  }, []);

  // ── Zoom handler ────────────────────────────────────────────────────────────

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect  = containerRef.current!.getBoundingClientRect();
    const cx    = e.clientX - rect.left;
    const cy    = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => {
      const next = Math.min(Math.max(z * delta, 0.25), 3);
      setPan((p) => ({
        x: cx - (cx - p.x) * (next / z),
        y: cy - (cy - p.y) * (next / z),
      }));
      return next;
    });
  }, []);

  // ── Node click → switch branch + scroll to turn ─────────────────────────────
  // 统一走 store.switchBranchAndLoad —— 与 BranchSiblingNav 同动作，双向联动。

  async function handleNodeClick(turn: TurnTreeNodeWire): Promise<void> {
    if (!sessionId) return;
    const turnBranch = turn.branchId as string | null;

    // Switch branch if the turn is on a different branch
    if (turnBranch && turnBranch !== active) {
      try {
        await useConversationStore.getState().switchBranchAndLoad(sessionId, turnBranch as BranchId);
      } catch (err) {
        showToast(err instanceof Error ? `切换分支失败: ${err.message}` : '切换分支失败', { variant: 'danger' });
        return;
      }
    }
    // Scroll chat to the clicked turn
    useConversationStore.getState().scrollToTurn(turn.id as string);
  }

  // ── Layout ───────────────────────────────────────────────────────────────────

  const positions = buildTurnLayout(branches, turns);

  const allPos = [...positions.values()];
  const svgW = allPos.length ? Math.max(...allPos.map((p) => p.x)) + NODE_W     : 200;
  const svgH = allPos.length ? Math.max(...allPos.map((p) => p.y)) + NODE_H * 2 : 200;

  // ── Active lineage path ─────────────────────────────────────────────────────
  // The "lineage" = active branch + all ancestor branches up to root.
  // For ancestor branches, only turns up to the fork point are on the lineage
  // (turns after the fork belong to a different branch's history).
  const activePath = new Set<string>();
  const forkCapByAncestor = new Map<string, number>(); // ancestorBranchId → forkTurn.startedAt
  if (active) {
    let cur: string | null = active;
    while (cur) {
      activePath.add(cur);
      const branch = branches.find((b) => (b.branchId as string) === cur);
      const parent = (branch?.parentBranchId as string | null) ?? null;
      if (parent && branch?.forkFromTurnId) {
        const forkTurn = turns.find((t) => (t.id as string) === (branch.forkFromTurnId as string));
        if (forkTurn) forkCapByAncestor.set(parent, forkTurn.startedAt);
      }
      cur = parent;
    }
  }

  function isOnLineage(turn: TurnTreeNodeWire): boolean {
    if (!active) return true; // no branches → all on main line
    const bid = turn.branchId as string | null;
    if (!bid || !activePath.has(bid)) return false;
    if (bid === active) return true;
    const cap = forkCapByAncestor.get(bid);
    return cap === undefined ? true : turn.startedAt <= cap;
  }

  const EDGE_ACTIVE   = 'var(--ema-primary)';
  const EDGE_INACTIVE = 'var(--ema-border-strong)';

  // ── Edges ────────────────────────────────────────────────────────────────────

  // Group turns by branch for edge computation
  const turnsByBranch = new Map<string, TurnTreeNodeWire[]>();
  for (const t of turns) {
    const bid = (t.branchId ?? '__null__') as string;
    const list = turnsByBranch.get(bid) ?? [];
    list.push(t);
    turnsByBranch.set(bid, list);
  }
  for (const list of turnsByBranch.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  const edges: JSX.Element[] = [];
  // Within-branch: vertical lines connecting consecutive turns
  for (const [bid, list] of turnsByBranch) {
    for (let i = 0; i < list.length - 1; i++) {
      const from = positions.get(list[i]!.id as string);
      const to   = positions.get(list[i + 1]!.id as string);
      if (!from || !to) continue;
      const onLineage = isOnLineage(list[i]!) && isOnLineage(list[i + 1]!);
      edges.push(
        <line key={`chain-${bid}-${i}`} x1={from.x} y1={from.y + NODE_R} x2={to.x} y2={to.y - NODE_R}
              stroke={onLineage ? EDGE_ACTIVE : EDGE_INACTIVE} strokeWidth={onLineage ? 2 : 1.5} />,
      );
    }
  }
  // Fork: curved line from fork turn → child branch's first turn
  for (const b of branches) {
    if (!b.forkFromTurnId) continue;
    const forkPos = positions.get(b.forkFromTurnId as string);
    const childTurns = turnsByBranch.get(b.branchId as string) ?? [];
    if (childTurns.length === 0 || !forkPos) continue;
    const childFirst = positions.get(childTurns[0]!.id as string);
    if (!childFirst) continue;
    const mx = (forkPos.y + childFirst.y) / 2;
    const onLineage = activePath.has(b.branchId as string);
    edges.push(
      <path key={`fork-${b.branchId}`} fill="none"
            stroke={onLineage ? EDGE_ACTIVE : EDGE_INACTIVE} strokeWidth={onLineage ? 2 : 1.5}
            d={`M ${forkPos.x} ${forkPos.y + NODE_R} C ${forkPos.x} ${mx}, ${childFirst.x} ${mx}, ${childFirst.x} ${childFirst.y - NODE_R}`} />,
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-xs ema-fade-in" style={{ color: 'var(--ema-text-tertiary)' }}>
        加载中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-xs ema-fade-in" style={{ color: 'var(--ema-text-tertiary)' }}>
        <span>{error}</span>
        <Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-xs ema-fade-in" style={{ color: 'var(--ema-text-tertiary)' }}>
        <span className="i-mdi:source-branch text-3xl opacity-30" aria-hidden />
        <span>暂无对话</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar — 仅统计 + 节点图，Fork 入口已移到消息气泡（ForkButton） */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0"
           style={{ borderColor: 'var(--ema-border)' }}>
        <span className="text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
          {branches.length > 0 ? `${branches.length} 条分支 · ${turns.length} 轮对话` : `${turns.length} 轮对话`}
        </span>
      </div>

      {/* Interactive canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      >
        {/* Inner transform group */}
        <div
          className="absolute"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
        >
          {/* SVG edges layer */}
          <svg
            width={svgW}
            height={svgH}
            className="absolute inset-0 pointer-events-none overflow-visible"
          >
            {edges}
          </svg>

          {/* Turn node divs — sorted oldest-first for staggered entrance */}
          {[...turns].sort((a, b) => a.startedAt - b.startedAt).map((turn, index) => {
            const p = positions.get(turn.id as string);
            if (!p) return null;
            const onLineage = isOnLineage(turn);
            const color = modeColor(turn.mode);

            return (
              <div
                key={turn.id as string}
                className="absolute flex flex-col items-center ema-fade-in"
                style={{
                  left:           p.x - LABEL_W / 2,
                  top:            p.y - NODE_R,
                  width:          LABEL_W,
                  cursor:         'pointer',
                  animationDelay: `${index * 40}ms`,
                }}
                onClick={() => void handleNodeClick(turn)}
              >
                {/* Circle */}
                <div
                  className="flex items-center justify-center rounded-full transition-all duration-150 shrink-0 active:scale-90"
                  style={{
                    width:     NODE_R * 2,
                    height:    NODE_R * 2,
                    background: onLineage ? color : 'var(--ema-surface-2)',
                    border:     `2px solid ${onLineage ? color : 'var(--ema-border)'}`,
                    boxShadow:  onLineage ? `0 0 12px ${color}55` : 'none',
                    color:      onLineage ? 'var(--ema-text-primary)' : 'var(--ema-text-tertiary)',
                  }}
                >
                  <ModeIcon mode={turn.mode} />
                </div>

                {/* Label */}
                <div
                  className="mt-1 text-center leading-snug"
                  style={{
                    fontSize:   '10px',
                    color:      onLineage ? 'var(--ema-text-primary)' : 'var(--ema-text-tertiary)',
                    fontWeight: onLineage ? 600 : 400,
                    maxWidth:   LABEL_W,
                    overflow:   'hidden',
                    display:    '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {turn.userInput.slice(0, 28) || '(空)'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Zoom hint */}
        <div
          className="absolute bottom-2 right-2 text-[10px] rounded px-1.5 py-0.5 pointer-events-none"
          style={{ color: 'var(--ema-text-tertiary)', background: 'var(--ema-surface-3)' }}
        >
          {Math.round(zoom * 100)}%
        </div>
      </div>
    </div>
  );
}
