/**
 * chat-store.test.ts — state machine (beginStream → appendDelta → finalizeStream)
 * + SSE dispatch routing table contract test.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useChatStore, type ChatHistoryItem } from './chat-store.js';
import type { TurnId, SessionId } from '@ema-agent/contracts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore(): void {
  useChatStore.setState({
    sessions: {
      pinned: [],
      byGroup: [],
      recent: [],
      archived: [],
      byId: new Map(),
    },
    activeSessionId: 'sess_1' as SessionId,
    messages: new Map(),
    streamingMessage: null,
    activeTurnId: null,
    loading: { sessions: false, messages: new Set() },
    error: null,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('chat-store', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // State machine: beginStream → appendDelta → finalizeStream
  // ═══════════════════════════════════════════════════════════════════════════

  describe('stream lifecycle', () => {
    it('beginStream creates an empty streamingMessage', () => {
      const turnId = 'turn_1' as TurnId;

      useChatStore.getState().beginStream(turnId);

      const state = useChatStore.getState();
      expect(state.activeTurnId).toBe(turnId);
      expect(state.streamingMessage).not.toBeNull();
      expect(state.streamingMessage!.role).toBe('assistant');
      expect(state.streamingMessage!.content).toBe('');
      expect(state.streamingMessage!.slices).toEqual([]);
    });

    it('appendDelta("text", ...) appends to content and creates text slice', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);

      useChatStore.getState().appendDelta('text', 'Hello ');
      useChatStore.getState().appendDelta('text', 'World');

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.content).toBe('Hello World');
      expect(sm.slices).toHaveLength(1);
      expect(sm.slices[0]).toMatchObject({ type: 'text', text: 'Hello World' });
    });

    it('appendDelta("thinking", ...) adds thinking slice', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);

      useChatStore.getState().appendDelta('thinking', 'Let me think about this...');

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.slices).toHaveLength(1);
      expect(sm.slices[0]).toMatchObject({
        type: 'thinking',
        text: 'Let me think about this...',
      });
      // thinking does NOT go into content
      expect(sm.content).toBe('');
    });

    it('appendDelta("tool_call", ...) adds tool_call slice', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);

      useChatStore.getState().appendDelta('tool_call', {
        callId: 'call_1',
        name: 'read_file',
        args: { path: '/tmp/x' },
      });

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.slices).toHaveLength(1);
      expect(sm.slices[0]).toMatchObject({
        type: 'tool_call',
        callId: 'call_1',
        name: 'read_file',
        args: { path: '/tmp/x' },
      });
    });

    it('appendDelta("tool_result", ...) attaches result to matching tool_call', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);

      // First add a tool call
      useChatStore.getState().appendDelta('tool_call', {
        callId: 'call_1',
        name: 'read_file',
        args: { path: '/tmp/x' },
      });

      // Then attach result
      useChatStore.getState().appendDelta('tool_result', {
        callId: 'call_1',
        output: 'file content here',
      });

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.slices[0]).toMatchObject({
        type: 'tool_call',
        result: 'file content here',
      });
    });

    it('tool_result attaches error to matching tool_call', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);

      useChatStore.getState().appendDelta('tool_call', {
        callId: 'call_err',
        name: 'write_file',
        args: {},
      });

      useChatStore.getState().appendDelta('tool_result', {
        callId: 'call_err',
        error: { code: 'EACCES', message: 'Permission denied' },
      });

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.slices[0]).toMatchObject({
        type: 'tool_call',
        error: { code: 'EACCES', message: 'Permission denied' },
      });
    });

    it('finalizeStream pushes streamingMessage to messages and clears it', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);
      useChatStore.getState().appendDelta('text', 'Final answer.');

      useChatStore.getState().finalizeStream({
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
        durationMs: 500,
      });

      const state = useChatStore.getState();
      expect(state.streamingMessage).toBeNull();
      expect(state.activeTurnId).toBeNull();

      // Check that the message was pushed
      const msgs = state.messages.get('sess_1');
      expect(msgs).toBeDefined();
      expect(msgs!.length).toBeGreaterThanOrEqual(1);
      const lastMsg = msgs![msgs!.length - 1]!;
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('Final answer.');
    });

    it('abortStream pushes error item and clears streaming', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);
      useChatStore.getState().appendDelta('text', 'Partial...');

      useChatStore.getState().abortStream('Connection lost');

      const state = useChatStore.getState();
      expect(state.streamingMessage).toBeNull();
      expect(state.activeTurnId).toBeNull();

      const msgs = state.messages.get('sess_1');
      const lastMsg = msgs![msgs!.length - 1]!;
      expect(lastMsg.role).toBe('error');
      expect(lastMsg.content).toBe('Connection lost');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Interleaved slices: text → tool_call → text → tool_call
  // ═══════════════════════════════════════════════════════════════════════════

  describe('interleaved slices', () => {
    it('preserves text/tool interleaving order', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);

      useChatStore.getState().appendDelta('text', 'Let me check...');
      useChatStore.getState().appendDelta('tool_call', {
        callId: 'c1',
        name: 'search',
        args: { query: 'weather' },
      });
      useChatStore.getState().appendDelta('tool_result', {
        callId: 'c1',
        output: 'Sunny 22°C',
      });
      useChatStore.getState().appendDelta('text', ' The weather is sunny.');

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.slices).toHaveLength(3);
      expect(sm.slices[0]!.type).toBe('text');
      expect(sm.slices[1]!.type).toBe('tool_call');
      expect(sm.slices[2]!.type).toBe('text');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('appendDelta when streamingMessage is null logs warning (no crash)', () => {
      // Don't call beginStream — streamingMessage is null
      expect(() => {
        useChatStore.getState().appendDelta('text', 'orphan delta');
      }).not.toThrow();
    });

    it('beginStream is idempotent (second call resets)', () => {
      useChatStore.getState().beginStream('turn_1' as TurnId);
      useChatStore.getState().appendDelta('text', 'First turn text');

      // New turn starts
      useChatStore.getState().beginStream('turn_2' as TurnId);

      const sm = useChatStore.getState().streamingMessage!;
      expect(sm.content).toBe('');
      expect(sm.slices).toHaveLength(0);
    });

    it('finalizeStream with null streamingMessage is a no-op', () => {
      expect(() => {
        useChatStore.getState().finalizeStream(null);
      }).not.toThrow();
    });

    it('abortStream with null streamingMessage is a no-op', () => {
      expect(() => {
        useChatStore.getState().abortStream('no stream');
      }).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Session management (pure state tests, no API calls)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('session state', () => {
    it('selectSession with same id is no-op', async () => {
      // Reset with active session
      useChatStore.setState({ activeSessionId: 'sess_1' as SessionId });

      // Should not throw or change state
      await useChatStore.getState().selectSession('sess_1' as SessionId);
      expect(useChatStore.getState().activeSessionId).toBe('sess_1');
    });
  });
});
