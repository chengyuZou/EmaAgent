/**
 * conversation-store.test.ts — per-session stream state machine tests.
 *
 * Covers: beginStream → appendDelta → finalizeStream / abortStream
 * All operations are scoped to a SessionId; parallel sessions don't interfere.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// tts-playback → live2d-react → pixi-live2d-display requires a browser DOM.
// Mock it so the store can be imported in a Node test environment.
vi.mock('../lib/tts-playback.js', () => ({
  handleTtsChunk: vi.fn(),
  handleTtsSentenceComplete: vi.fn(),
}));

import { useConversationStore } from './conversation-store.js';
import type { TurnId, SessionId } from '@ema-agent/contracts';

const S1 = 'sess_1' as SessionId;
const S2 = 'sess_2' as SessionId;
const T1 = 'turn_1' as TurnId;
const T2 = 'turn_2' as TurnId;

function resetStore(): void {
  useConversationStore.setState({
    viewedSessionId:   null,
    ttsOwnerSessionId: null,
    messages:          new Map(),
    streamingMap:      new Map(),
    stopReasonMap:     new Map(),
    draftMap:          new Map(),
    loading:           { messages: new Set() },
    error:             null,
  });
}

describe('conversation-store', () => {
  beforeEach(resetStore);

  // ═══════════════════════════════════════════════════════════════════════════
  // Stream lifecycle: beginStream → appendDelta → finalizeStream
  // ═══════════════════════════════════════════════════════════════════════════

  describe('stream lifecycle', () => {
    it('beginStream creates an empty streaming entry for the session', () => {
      useConversationStore.getState().beginStream(S1, T1);

      const sm = useConversationStore.getState().streamingMap.get(S1 as string);
      expect(sm).toBeDefined();
      expect(sm!.role).toBe('assistant');
      expect(sm!.content).toBe('');
      expect(sm!.slices).toEqual([]);
    });

    it('appendDelta("text") accumulates content and coalesces text slices', () => {
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'text', 'Hello ');
      useConversationStore.getState().appendDelta(S1, 'text', 'World');

      const sm = useConversationStore.getState().streamingMap.get(S1 as string)!;
      expect(sm.content).toBe('Hello World');
      expect(sm.slices).toHaveLength(1);
      expect(sm.slices[0]).toMatchObject({ type: 'text', text: 'Hello World' });
    });

    it('appendDelta("thinking") adds thinking slice (does not go into content)', () => {
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'thinking', 'Let me think...');

      const sm = useConversationStore.getState().streamingMap.get(S1 as string)!;
      expect(sm.content).toBe('');
      expect(sm.slices).toHaveLength(1);
      expect(sm.slices[0]).toMatchObject({ type: 'thinking', text: 'Let me think...' });
    });

    it('appendDelta("tool_call") adds tool_call slice', () => {
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'tool_call', {
        callId: 'call_1', name: 'read_file', args: { path: '/tmp/x' },
      });

      const sm = useConversationStore.getState().streamingMap.get(S1 as string)!;
      expect(sm.slices).toHaveLength(1);
      expect(sm.slices[0]).toMatchObject({ type: 'tool_call', callId: 'call_1', name: 'read_file' });
    });

    it('appendDelta("tool_result") attaches result to matching tool_call', () => {
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'tool_call', {
        callId: 'call_1', name: 'read_file', args: { path: '/tmp/x' },
      });
      useConversationStore.getState().appendDelta(S1, 'tool_result', {
        callId: 'call_1', output: 'file content',
      });

      const sm = useConversationStore.getState().streamingMap.get(S1 as string)!;
      expect(sm.slices[0]).toMatchObject({ type: 'tool_call', result: 'file content' });
    });

    it('finalizeStream pushes message to history and removes streaming entry', () => {
      useConversationStore.setState({ messages: new Map([[S1 as string, []]]) });
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'text', 'Final answer.');
      useConversationStore.getState().finalizeStream(S1, null);

      const state = useConversationStore.getState();
      expect(state.streamingMap.has(S1 as string)).toBe(false);

      const msgs = state.messages.get(S1 as string);
      expect(msgs).toBeDefined();
      const last = msgs![msgs!.length - 1]!;
      expect(last.role).toBe('assistant');
      expect(last.content).toBe('Final answer.');
    });

    it('abortStream preserves partial content in history and sets stopReason', () => {
      useConversationStore.setState({ messages: new Map([[S1 as string, []]]) });
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'text', 'Partial...');
      useConversationStore.getState().abortStream(S1, 'Connection lost');

      const state = useConversationStore.getState();
      expect(state.streamingMap.has(S1 as string)).toBe(false);
      expect(state.stopReasonMap.get(S1 as string)).toBe('Connection lost');

      const msgs = state.messages.get(S1 as string);
      expect(msgs![msgs!.length - 1]).toMatchObject({ role: 'assistant', content: 'Partial...' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-session isolation: two sessions stream independently
  // ═══════════════════════════════════════════════════════════════════════════

  describe('per-session isolation', () => {
    it('two sessions stream in parallel without interfering', () => {
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().beginStream(S2, T2);

      useConversationStore.getState().appendDelta(S1, 'text', 'Session1');
      useConversationStore.getState().appendDelta(S2, 'text', 'Session2');

      const sm1 = useConversationStore.getState().streamingMap.get(S1 as string)!;
      const sm2 = useConversationStore.getState().streamingMap.get(S2 as string)!;
      expect(sm1.content).toBe('Session1');
      expect(sm2.content).toBe('Session2');
    });

    it('finalizing one session does not affect the other', () => {
      useConversationStore.setState({
        messages: new Map([[S1 as string, []], [S2 as string, []]]),
      });
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().beginStream(S2, T2);
      useConversationStore.getState().appendDelta(S1, 'text', 'Done1');
      useConversationStore.getState().appendDelta(S2, 'text', 'Still going');

      useConversationStore.getState().finalizeStream(S1, null);

      const state = useConversationStore.getState();
      expect(state.streamingMap.has(S1 as string)).toBe(false);
      expect(state.streamingMap.has(S2 as string)).toBe(true);
      expect(state.streamingMap.get(S2 as string)!.content).toBe('Still going');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Interleaved slices
  // ═══════════════════════════════════════════════════════════════════════════

  describe('interleaved slices', () => {
    it('preserves text → tool → text order', () => {
      useConversationStore.getState().beginStream(S1, T1);
      useConversationStore.getState().appendDelta(S1, 'text', 'Let me check...');
      useConversationStore.getState().appendDelta(S1, 'tool_call', {
        callId: 'c1', name: 'search', args: { query: 'weather' },
      });
      useConversationStore.getState().appendDelta(S1, 'tool_result', {
        callId: 'c1', output: 'Sunny 22°C',
      });
      useConversationStore.getState().appendDelta(S1, 'text', ' The weather is sunny.');

      const sm = useConversationStore.getState().streamingMap.get(S1 as string)!;
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
    it('appendDelta when no streaming entry is a no-op (no crash)', () => {
      expect(() => {
        useConversationStore.getState().appendDelta(S1, 'text', 'orphan delta');
      }).not.toThrow();
    });

    it('finalizeStream with no streaming entry is a no-op', () => {
      expect(() => {
        useConversationStore.getState().finalizeStream(S1, null);
      }).not.toThrow();
    });

    it('draftMap survives session operations', () => {
      useConversationStore.getState().setDraft(S1, 'draft text');
      expect(useConversationStore.getState().draftMap.get(S1 as string)).toBe('draft text');

      useConversationStore.getState().setDraft(S1, '');
      expect(useConversationStore.getState().draftMap.has(S1 as string)).toBe(false);
    });
  });
});
