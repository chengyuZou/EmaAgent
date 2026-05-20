import type { EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmMessage, AssistantBlock, UserBlock } from '@ema-agent/llm';
import type { Message } from '@ema-agent/session';
import type { MessageBlocks } from '@ema-agent/session';
import type { ToolResultBlock } from '@ema-agent/contracts';
import type { ToolExecutionContext, ReadFileState } from '@ema-agent/tool';
import type { PermissionContext } from '@ema-agent/permission';
import type { AgentDeps, AgentRunInput } from './types.js';
import { AgentPolicy } from './policy.js';

// ── AgentEngine ───────────────────────────────────────────────────────────────

/**
 * Handles agent turns via a think→act multi-round loop.
 *
 * Contract:
 *  - Caller must have called session.startTurn() and passes the resulting turn + signal.
 *  - Engine is transport-agnostic: returns AsyncIterable<EmaStreamEvent>.
 *  - All cross-cutting concerns (memory, TTS, OOC) live in hooks — engine has none.
 */
export class AgentEngine {
  constructor(private readonly deps: AgentDeps) {}

  run(input: AgentRunInput): AsyncIterable<EmaStreamEvent> {
    return runTurn(this.deps, input);
  }
}

// ── Core turn loop ────────────────────────────────────────────────────────────

async function* runTurn(
  deps: AgentDeps,
  input: AgentRunInput,
): AsyncIterable<EmaStreamEvent> {
  const { session, hooks, llm, emotion, tools, permission } = deps;
  const { turn, signal, sessionId, subMode, userInput, systemPrompt, workspaceRoot } = input;
  const turnId   = turn.id;
  const startedAt = Date.now();

  // Per-turn state
  const policy        = new AgentPolicy(subMode, tools.list());
  const readFileState = new Map() as ReadFileState;
  let totalInput      = 0;
  let totalOutput     = 0;
  let iterations      = 0;
  let llmDone         = false;

  // Mid-execution events emitted by tools (todo_write, etc.)
  const pendingToolEvents: EmaStreamEvent[] = [];
  const toolEmit = (ev: EmaStreamEvent) => pendingToolEvents.push(ev);

  const permCtx: PermissionContext = {
    workspaceRoot,
    additionalWorkingDirs: input.additionalWorkingDirs,
    sessionId,
  };

  // Resolve sandbox runner: explicit override > per-session factory > none.
  const resolvedRunner = deps.commandRunner
    ?? deps.getCommandRunner?.(sessionId);

  const toolCtx: ToolExecutionContext = {
    sessionId,
    turnId,
    workspaceRoot,
    additionalWorkingDirs: input.additionalWorkingDirs,
    signal,
    readFileState,
    emit:          toolEmit,
    commandRunner: resolvedRunner,
  };

  try {
    emotion.beginTurn();

    // ── onTurnStart ───────────────────────────────────────────────────────────
    const startResult = await hooks.trigger('onTurnStart', {
      turnId, sessionId,
      payload: { mode: 'agent', subMode },
      meta: {},
    });
    if (startResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', startResult.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    yield { type: 'turn_started', turnId, mode: 'agent', subMode };

    // ── Build initial message history ─────────────────────────────────────────
    const history = session.loadHistory(sessionId);
    const userBlocks: string | UserBlock[] =
      input.contentParts?.length ? input.contentParts : userInput;

    session.appendMessage({
      turnId, sessionId, role: 'user',
      blocks: userBlocks as MessageBlocks,
    });

    // Conversation history for the LLM. The caller-provided systemPrompt is
    // prepended as a sensible default — the prompts:buildSystem hook (priority
    // 10) will REPLACE it in-place when registered. Embedders without that
    // hook (tests, minimal hosts) still get a working system message.
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyToLlmMessages(history),
      { role: 'user', content: userBlocks as string | UserBlock[] },
    ];

    // ── Provider resolution ───────────────────────────────────────────────────
    const binding      = deps.modelBindings.get('agent');
    const providerId   = binding?.providerConfigId ?? llm.firstProviderId();
    const resolvedModel = input.model ?? binding?.model
      ?? (providerId ? llm.defaultModelFor(providerId) : undefined);

    if (!providerId || !resolvedModel) {
      session.failTurn(turnId, 'provider/not_configured', 'No LLM provider configured for agent mode');
      yield { type: 'turn_failed', turnId, code: 'provider/not_configured', message: 'No LLM provider configured for agent mode' };
      return;
    }

    // ── beforeLlm hook (initial) ──────────────────────────────────────────────
    const preLlm = await hooks.trigger('beforeLlm', {
      turnId, sessionId,
      payload: { systemPrompt, messages },
      meta: { mode: 'agent', subMode, userInput, signal },
    });
    if (preLlm.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', preLlm.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: preLlm.reason };
      return;
    }
    // Splice hook-updated messages in-place (e.g. memory recall injected by a hook)
    messages.splice(0, messages.length, ...preLlm.payload.messages);

    // ── think→act loop ────────────────────────────────────────────────────────
    while (true) {
      if (signal.aborted) break;

      iterations++;
      yield { type: 'agent_iteration', n: iterations };

      // ── THINK: stream one LLM response ─────────────────────────────────────
      const assistantBlocks: AssistantBlock[] = [];
      let   textByIndex   = new Map<number, string>();
      let   stopReason    = 'end_turn';

      const stream = llm.stream({
        providerId, model: resolvedModel,
        messages,
        tools:      policy.toolDefs(),
        toolChoice: 'auto',
        signal,
      });

      const deltaPromises: Promise<unknown>[] = [];

      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'text_delta': {
            const { cleaned, events } = emotion.processChunk(chunk.delta, turnId);
            if (cleaned) {
              textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + cleaned);
              yield { type: 'output_text_delta', blockIndex: chunk.blockIndex, delta: cleaned };
            }
            for (const ev of events) yield ev;
            deltaPromises.push(
              hooks.trigger('afterLlmDelta', {
                turnId, sessionId,
                payload: { delta: chunk.delta, accumulated: textByIndex.get(chunk.blockIndex) ?? '' },
                meta: {},
              }),
            );
            break;
          }
          case 'thinking_delta':
            yield { type: 'reasoning_delta', blockIndex: chunk.blockIndex, delta: chunk.delta };
            break;
          case 'tool_use_delta':
            yield {
              type: 'tool_call_partial',
              blockIndex: chunk.blockIndex,
              callId: chunk.callId, name: chunk.name, argsDelta: chunk.argsDelta,
            };
            break;
          case 'tool_use_complete':
            assistantBlocks.push({ type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args });
            yield {
              type: 'tool_call_complete',
              blockIndex: chunk.blockIndex,
              callId: chunk.callId, name: chunk.name, args: chunk.args,
            };
            break;
          case 'usage':
            totalInput  += chunk.inputTokens;
            totalOutput += chunk.outputTokens;
            break;
          case 'done':
            stopReason = chunk.stopReason;
            break;
        }
      }
      llmDone = true;

      // Flush emotion scanner tail
      const { cleaned: tail } = emotion.flush(turnId);
      if (tail) {
        const idx = 1; // text lives at blockIndex 1 in OpenAI adapter
        textByIndex.set(idx, (textByIndex.get(idx) ?? '') + tail);
        yield { type: 'output_text_delta', blockIndex: idx, delta: tail };
      }

      await Promise.allSettled(deltaPromises);

      // Reconstruct full text from indexed buffers
      const fullText = [...textByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => t)
        .join('');

      // Build final AssistantBlock[] (text + tool_use, in blockIndex order)
      const allBlocks: AssistantBlock[] = [];
      for (const [idx, text] of [...textByIndex.entries()].sort(([a], [b]) => a - b)) {
        allBlocks.push({ type: 'text', text });
        void idx;
      }
      for (const b of assistantBlocks) allBlocks.push(b);

      await hooks.trigger('afterLlmComplete', {
        turnId, sessionId,
        payload: { content: fullText, toolCalls: assistantBlocks },
        meta: {},
      });

      const toolUseBlocks = assistantBlocks.filter(
        (b): b is AssistantBlock & { type: 'tool_use' } => b.type === 'tool_use',
      );

      // ── End condition: no tool calls or model said stop ─────────────────────
      if (stopReason === 'end_turn' || toolUseBlocks.length === 0) {
        for (const [idx, text] of [...textByIndex.entries()].sort(([a], [b]) => a - b)) {
          yield { type: 'output_text_complete', blockIndex: idx, text };
        }
        const msg = session.appendMessage({
          turnId, sessionId, role: 'assistant',
          blocks: allBlocks as MessageBlocks,
        });
        await hooks.trigger('afterMessage', {
          turnId, sessionId,
          payload: { messageId: msg.id, role: 'assistant', content: fullText },
          meta: {},
        });
        break;
      }

      // Persist mid-loop assistant turn (has tool_use blocks)
      session.appendMessage({
        turnId, sessionId, role: 'assistant',
        blocks: allBlocks as MessageBlocks,
      });
      messages.push({ role: 'assistant', content: allBlocks });

      // ── ACT: execute all tool_use blocks in order ───────────────────────────
      const resultBlocks: ToolResultBlock[] = [];

      for (const block of toolUseBlocks) {
        // Policy check (plan mode blocks write tools)
        if (!policy.allows(block.name)) {
          const denied = `Tool "${block.name}" is not available in "${subMode}" mode`;
          resultBlocks.push({ type: 'tool_result', toolUseId: block.id, content: denied, isError: true });
          yield { type: 'tool_result', callId: block.id, error: { code: 'policy/denied', message: denied } };
          continue;
        }

        await hooks.trigger('beforeToolUse', {
          turnId, sessionId,
          payload: { callId: block.id, name: block.name, args: block.args },
          meta: {},
        });

        // Permission gate
        if (!tools.has(block.name)) {
          const msg = `Unknown tool: "${block.name}"`;
          resultBlocks.push({ type: 'tool_result', toolUseId: block.id, content: msg, isError: true });
          yield { type: 'tool_result', callId: block.id, error: { code: 'tool/not_found', message: msg } };
          continue;
        }
        const toolEntry = tools.get(block.name);

        const outcome = await permission.gate(block.name, block.args, toolEntry.permissionMeta, permCtx);

        if (!outcome.granted) {
          const reason = `Permission denied: ${(outcome as { reason: string }).reason}`;
          resultBlocks.push({ type: 'tool_result', toolUseId: block.id, content: reason, isError: true });
          yield { type: 'tool_result', callId: block.id, error: { code: 'permission/denied', message: reason } };
          await hooks.trigger('onToolFailure', {
            turnId, sessionId,
            payload: { callId: block.id, name: block.name, error: reason },
            meta: {},
          });
          continue;
        }

        // Execute
        let output: unknown;
        let isError = false;

        try {
          output = await tools.dispatch(block.name, block.args, toolCtx);

          // Drain any events the tool emitted via ctx.emit
          while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;

          yield { type: 'tool_result', callId: block.id, output };
          await hooks.trigger('afterToolUse', {
            turnId, sessionId,
            payload: { callId: block.id, name: block.name, output },
            meta: {},
          });
        } catch (err) {
          isError = true;
          output = (err as Error).message;
          while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;
          yield { type: 'tool_result', callId: block.id, error: { code: 'tool/error', message: output as string } };
          await hooks.trigger('onToolFailure', {
            turnId, sessionId,
            payload: { callId: block.id, name: block.name, error: err },
            meta: {},
          });
        } finally {
          // Scrub any bare-repo attack files planted during this tool's execution
          // before the next git call can see them. Must run regardless of outcome.
          resolvedRunner?.cleanup();
        }

        const serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        resultBlocks.push({ type: 'tool_result', toolUseId: block.id, content: serialized, isError });
      }

      // Persist tool results + inject into LLM history
      session.appendMessage({
        turnId, sessionId, role: 'user',
        kind: 'tool_results',
        blocks: resultBlocks as MessageBlocks,
      });
      messages.push({ role: 'user', content: resultBlocks });

      // ── Circuit breaker ─────────────────────────────────────────────────────
      if (iterations >= policy.maxIterations()) {
        yield { type: 'agent_breaker_tripped', reason: `max iterations (${policy.maxIterations()}) reached` };
        break;
      }
    }

    // ── Turn teardown ─────────────────────────────────────────────────────────
    const durationMs = Date.now() - startedAt;
    await hooks.trigger('onTurnEnd', {
      turnId, sessionId,
      payload: { durationMs },
      meta: {},
    });

    session.completeTurn(turnId, {
      usageInputTokens:  totalInput,
      usageOutputTokens: totalOutput,
      iterations,
    });
    yield {
      type: 'turn_completed', turnId,
      usage: { inputTokens: totalInput, outputTokens: totalOutput, costUsd: 0, durationMs },
    };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (signal.aborted && !llmDone) {
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        meta: {},
      });
      session.abortTurn(sessionId, turnId);
      yield { type: 'turn_aborted', turnId, reason: 'user_stop' };
    } else {
      session.failTurn(turnId, 'provider/server_error', reason);
      yield { type: 'turn_failed', turnId, code: 'provider/server_error', message: reason };
    }
  }
}

// ── History → LlmMessage (mirrors conversation/engine.ts — no shared import) ──

function historyToLlmMessages(history: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const msg of history) {
    switch (msg.role) {
      case 'system':
        out.push({ role: 'system', content: typeof msg.blocks === 'string' ? msg.blocks : '' });
        break;
      case 'user':
        out.push({ role: 'user', content: msg.blocks as string | UserBlock[] });
        break;
      case 'assistant':
        if (Array.isArray(msg.blocks)) {
          out.push({ role: 'assistant', content: msg.blocks as AssistantBlock[] });
        }
        break;
    }
  }
  return out;
}
