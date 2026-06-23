/**
 * BranchPanel — interactive branch tree for the current session.
 *
 * Layout: top-down tree. Each node = one branch, labeled by the user's query
 * at the fork point (first 28 chars). Mode icon distinguishes Chat / Agent / Narrative.
 *
 * Interactions:
 *   - Mouse drag  → pan
 *   - Scroll wheel → zoom (centered on cursor)
 *   - Click node   → switch to that branch + scroll ChatHistory to the fork turn
 */
import { useState, useEffect, useRef, useCallback, type JSX } from 'react';
import type { BranchId, TurnId, TurnMode } from '@ema-agent/contracts';
import { sessionsApi, type BranchNodeWire } from '../api/sessions.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W   = 160;   // horizontal distance between leaf columns
const NODE_H   = 110;   // vertical distance between tree levels
const NODE_R   = 26;    // node circle radius
const LABEL_W  = 130;   // max label width in px

// Synthetic id for the implicit main line shown when a session has no forks.
const MAIN_BRANCH_SENTINEL = '__main__';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NodePos { x: number; y: number }

// ── Layout algorithm ──────────────────────────────────────────────────────────

function buildLayout(nodes: BranchNodeWire[]): Map<string, NodePos> {
  if (nodes.length === 0) return new Map();

  const children = new Map<string | null, string[]>();
  for (const n of nodes) {
    const p = n.parentBranchId as string | null;
    const list = children.get(p) ?? [];
    list.push(n.branchId as string);
    children.set(p, list);
  }

  const pos = new Map<string, NodePos>();
  let leafCounter = 0;

  function place(id: string, depth: number): void {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      pos.set(id, { x: leafCounter * NODE_W, y: depth * NODE_H });
      leafCounter++;
      return;
    }
    for (const kid of kids) place(kid, depth + 1);
    const first = pos.get(kids[0]!)!;
    const last  = pos.get(kids[kids.length - 1]!)!;
    pos.set(id, { x: (first.x + last.x) / 2, y: depth * NODE_H });
  }

  // Roots = nodes with no parent
  const roots = nodes.filter((n) => n.parentBranchId === null).map((n) => n.branchId as string);
  for (const root of roots) place(root, 0);

  // Centre horizontally
  const xs = [...pos.values()].map((p) => p.x);
  const minX = Math.min(...xs);
  for (const [id, p] of pos) pos.set(id, { x: p.x - minX + NODE_W / 2, y: p.y + NODE_R + 8 });

  return pos;
}

// ── Mode icon ─────────────────────────────────────────────────────────────────

function ModeIcon({ mode }: { mode: TurnMode | null }): JSX.Element {
  const icon =
    mode === 'agent'     ? 'i-mdi:robot-outline' :
    mode === 'narrative' ? 'i-mdi:book-open-variant-outline' :
                           'i-mdi:chat-outline';
  return <span className={`${icon} text-base`} aria-hidden />;
}

function modeColor(mode: TurnMode | null): string {
  if (mode === 'agent')     return 'var(--ema-info)';
  if (mode === 'narrative') return 'var(--ema-warning)';
  return                           'var(--ema-primary)';
}

// ── BranchPanel ───────────────────────────────────────────────────────────────

export function BranchPanel(): JSX.Element {
  const sessionId = useConversationStore((s) => s.viewedSessionId);

  const [tree, setTree]     = useState<BranchNodeWire[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  // Pan + zoom state
  const [pan,  setPan]  = useState({ x: 0, y: 20 });
  const [zoom, setZoom] = useState(1);
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await sessionsApi.listBranches(sessionId);
      setTree(data.branches);
      setActive(data.sessionActiveBranchId as string | null);
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
    const rect   = containerRef.current!.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const delta  = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => {
      const next = Math.min(Math.max(z * delta, 0.25), 3);
      // Keep point under cursor fixed: adjust pan to compensate scale change
      setPan((p) => ({
        x: cx - (cx - p.x) * (next / z),
        y: cy - (cy - p.y) * (next / z),
      }));
      return next;
    });
  }, []);

  // ── Node click → switch branch + scroll ─────────────────────────────────────

  async function handleNodeClick(node: BranchNodeWire): Promise<void> {
    if (!sessionId) return;
    // The synthetic main-line node has no real branch row to switch to.
    if ((node.branchId as string) === MAIN_BRANCH_SENTINEL) return;
    if ((node.branchId as string) === active) {
      // Already on this branch — just scroll to the fork turn
      if (node.forkFromTurnId) {
        useConversationStore.getState().scrollToTurn(node.forkFromTurnId as string);
      }
      return;
    }
    try {
      await sessionsApi.switchBranch(sessionId, node.branchId);
      setActive(node.branchId as string);
      // Reload session list + messages to reflect new branch
      await useSessionStore.getState().loadSessions();
      await useConversationStore.getState().loadMessages(sessionId);
      if (node.forkFromTurnId) {
        useConversationStore.getState().scrollToTurn(node.forkFromTurnId as string);
      }
    } catch { /* non-critical */ }
  }

  // ── Fork current session ─────────────────────────────────────────────────────

  async function handleFork(): Promise<void> {
    if (!sessionId) return;
    // Find last completed turn from message history
    const messages = useConversationStore.getState().messages.get(sessionId as string) ?? [];
    const lastTurn = [...messages].reverse().find((m) => m.turnId);
    if (!lastTurn?.turnId) return;
    try {
      await sessionsApi.forkBranch(sessionId, lastTurn.turnId as TurnId);
      await load();
    } catch { /* non-critical */ }
  }

  // ── Layout ───────────────────────────────────────────────────────────────────

  // A fork-less session has no branch rows; show the implicit main line as a
  // single root node so the panel always renders a chain (linked-list view).
  const effectiveTree: BranchNodeWire[] = tree.length > 0 ? tree : [{
    branchId:       MAIN_BRANCH_SENTINEL as BranchId,
    parentBranchId: null,
    forkFromTurnId: null,
    forkUserInput:  '主线',
    forkTurnMode:   null,
    isActive:       true,
    createdAt:      0,
  }];
  const effectiveActive = tree.length > 0 ? active : MAIN_BRANCH_SENTINEL;

  const positions = buildLayout(effectiveTree);

  // SVG canvas size = bounding box of all nodes + padding
  const allPos = [...positions.values()];
  const svgW = allPos.length ? Math.max(...allPos.map((p) => p.x)) + NODE_W     : 200;
  const svgH = allPos.length ? Math.max(...allPos.map((p) => p.y)) + NODE_H * 2 : 200;

  // ── Edge paths ────────────────────────────────────────────────────────────────

  const edges: JSX.Element[] = [];
  for (const node of effectiveTree) {
    if (!node.parentBranchId) continue;
    const from = positions.get(node.parentBranchId as string);
    const to   = positions.get(node.branchId as string);
    if (!from || !to) continue;
    const mx = (from.x + to.x) / 2;
    edges.push(
      <path
        key={`${node.parentBranchId}-${node.branchId}`}
        d={`M ${from.x} ${from.y + NODE_R} C ${from.x} ${mx}, ${to.x} ${from.y + NODE_R}, ${to.x} ${to.y - NODE_R}`}
        fill="none"
        stroke="var(--ema-border-strong)"
        strokeWidth={1.5}
      />,
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

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
        <button className="text-[var(--ema-primary)] hover:text-[var(--ema-primary-hover)]" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0"
           style={{ borderColor: 'var(--ema-border)' }}>
        <span className="text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
          {tree.length > 0 ? `${tree.length} 条分支` : '主线（未分支）'}
        </span>
        <button
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors"
          style={{ color: 'var(--ema-text-secondary)' }}
          onClick={() => void handleFork()}
          title="从当前对话末尾 Fork 新分支"
        >
          <span className="i-mdi:source-fork text-sm" aria-hidden />
          Fork
        </button>
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

          {/* Node divs */}
          {effectiveTree.map((node) => {
            const p      = positions.get(node.branchId as string);
            if (!p) return null;
            const isActive = (node.branchId as string) === effectiveActive;
            const color    = modeColor(node.forkTurnMode);

            return (
              <div
                key={node.branchId as string}
                className="absolute flex flex-col items-center"
                style={{
                  left:      p.x - LABEL_W / 2,
                  top:       p.y - NODE_R,
                  width:     LABEL_W,
                  transform: 'none',
                  cursor:    'pointer',
                }}
                onClick={() => void handleNodeClick(node)}
              >
                {/* Circle */}
                <div
                  className="flex items-center justify-center rounded-full transition-all duration-150 shrink-0"
                  style={{
                    width:     NODE_R * 2,
                    height:    NODE_R * 2,
                    background: isActive ? color : 'var(--ema-surface-2)',
                    border:     `2px solid ${isActive ? color : 'var(--ema-border)'}`,
                    boxShadow:  isActive ? `0 0 12px ${color}55` : 'none',
                    color:      isActive ? 'var(--ema-text-primary)' : 'var(--ema-text-tertiary)',
                  }}
                >
                  <ModeIcon mode={node.forkTurnMode} />
                </div>

                {/* Label */}
                <div
                  className="mt-1.5 text-center leading-snug"
                  style={{
                    fontSize:   '10px',
                    color:      isActive ? 'var(--ema-text-primary)' : 'var(--ema-text-tertiary)',
                    fontWeight: isActive ? 600 : 400,
                    maxWidth:   LABEL_W,
                    overflow:   'hidden',
                    display:    '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {node.forkUserInput || '(起始)'}
                </div>

                {/* Active badge */}
                {isActive && (
                  <div
                    className="mt-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold"
                    style={{ background: `${color}28`, color }}
                  >
                    当前
                  </div>
                )}
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
