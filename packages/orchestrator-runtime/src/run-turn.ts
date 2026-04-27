import { ErrorCode, EmaError } from "@ema-agent/constants-core";
import type { ChatMessage, EmaMode, EmaStreamEvent, EmaTurnMetadata, StepView } from "@ema-agent/core-types";
import { appendMessage, createTurnRecord, getOrCreateSession, markTurnMetadata } from "@ema-agent/session-runtime";
import { prepareRuntimeInput } from "./input-pipeline.js";

export type ChatMode = EmaMode;

export interface RunTurnRequest {
  sessionId: string;
  mode: ChatMode;
  rawUserQuery: string;
}

export interface RunTurnResult {
  requestId: string;
  stream: AsyncIterable<EmaStreamEvent>;
}

interface RunChatTurnRequest {
  requestId: string;
  traceId: string;
  sessionId: string;
  mode: EmaMode;
  rawUserQuery: string;
}

export async function runTurn(req: RunTurnRequest): Promise<RunTurnResult> {
  const requestId = crypto.randomUUID();
  const traceId = crypto.randomUUID();

  if (!req.rawUserQuery.trim()) {
    throw new EmaError(ErrorCode.PARAM_INVALID, "rawUserQuery cannot be empty.", false);
  }

  return {
    requestId,
    stream: runChatTurn({
      requestId,
      traceId,
      sessionId: req.sessionId,
      mode: req.mode,
      rawUserQuery: req.rawUserQuery,
    }),
  };
}

export async function* runChatTurn(req: RunChatTurnRequest): AsyncIterable<EmaStreamEvent> {
  const startedAt = Date.now();
  const session = await getOrCreateSession(req.sessionId);
  await createTurnRecord({
    requestId: req.requestId,
    sessionId: req.sessionId,
    mode: req.mode,
    status: "running",
    providerId: "local-dev",
    modelId: "minimal-fake-provider",
    startedAt,
  });
  const prepared = prepareRuntimeInput({
    rawUserQuery: req.rawUserQuery,
    recentMessages: session.messages,
    mode: req.mode,
  });

  yield {
    type: "turn_started",
    requestId: req.requestId,
    sessionId: req.sessionId,
    mode: req.mode,
    at: startedAt,
  };

  yield {
    type: "context_snapshot",
    requestId: req.requestId,
    budget: {
      maxTokens: 8192,
      usedTokens: estimateTokens(prepared.envelope.runtimeSystemPrompt) + estimateTokens(prepared.envelope.rawUserQuery),
      reservedOutputTokens: 1024,
      compactionTriggered: false,
    },
    sources: [
      {
        id: "system-prompt",
        source: "system",
        title: "Ema 角色与模式规则",
        tokenEstimate: estimateTokens(prepared.envelope.runtimeSystemPrompt),
        included: true,
      },
    ],
  };

  const userMessage = createMessage("user", prepared.envelope.rawUserQuery, req.requestId);
  await appendMessage(req.sessionId, userMessage);

  const responseStep = createStep(req.requestId, "response", "running", buildStepTitle(req.mode));
  yield {
    type: "step_started",
    requestId: req.requestId,
    step: responseStep,
  };

  const assistantText = buildAssistantReply({
    mode: req.mode,
    rawUserQuery: prepared.envelope.rawUserQuery,
    recentMessages: prepared.recentMessages,
  });

  for (const [index, chunk] of Array.from(assistantText).entries()) {
    yield {
      type: "output_text_delta",
      requestId: req.requestId,
      blockId: `assistant-${req.requestId}`,
      delta: chunk,
      index,
    };
  }

  const assistantMessage = createMessage("assistant", assistantText, req.requestId);
  await appendMessage(req.sessionId, assistantMessage);

  const metadata = buildTurnMetadata({
    mode: req.mode,
    sessionId: req.sessionId,
    requestId: req.requestId,
    traceId: req.traceId,
    rawUserQuery: prepared.envelope.rawUserQuery,
    assistantText,
    latencyMs: Date.now() - startedAt,
  });

  await markTurnMetadata(req.sessionId, req.requestId, metadata);

  yield {
    type: "usage_report",
    requestId: req.requestId,
    usage: metadata.usage,
  };

  yield {
    type: "step_updated",
    requestId: req.requestId,
    stepId: responseStep.id,
    patch: {
      status: "completed",
      endedAt: Date.now(),
      detail: `耗时 ${metadata.latencyMs}ms`,
    },
  };

  yield {
    type: "turn_completed",
    requestId: req.requestId,
    assistantMessageId: assistantMessage.id,
    at: Date.now(),
  };
}

export function buildTurnMetadata(args: {
  mode: EmaMode;
  sessionId: string;
  requestId: string;
  traceId: string;
  rawUserQuery: string;
  assistantText: string;
  latencyMs: number;
}): EmaTurnMetadata {
  const inputTokens = estimateTokens(args.rawUserQuery);
  const outputTokens = estimateTokens(args.assistantText);

  return {
    mode: args.mode,
    sessionId: args.sessionId,
    requestId: args.requestId,
    traceId: args.traceId,
    model: {
      provider: "local-dev",
      modelId: "minimal-fake-provider",
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    latencyMs: args.latencyMs,
    recalls: {
      sources: {},
      totalTokens: 0,
      compactionTriggered: false,
    },
    toolCalls: [],
    safety: {
      sandboxMode: "strict",
      fullAccessGranted: false,
      deniedCount: 0,
    },
  };
}

function buildAssistantReply(args: {
  mode: EmaMode;
  rawUserQuery: string;
  recentMessages: ChatMessage[];
}): string {
  const historyNote =
    args.recentMessages.length === 0
      ? "This is the first minimal loop turn."
      : `Loaded ${args.recentMessages.length} recent messages from storage.`;

  return [
    `Ema 收到：${args.rawUserQuery}`,
    `本轮模式：${args.mode}。`,
    historyNote,
    "现在还是最小闭环的假流式输出；后续会接入真实 provider 和对应 runtime。",
  ].join("\n");
}

function createMessage(role: ChatMessage["role"], content: string, requestId: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    contentBlocks: [{ type: "text", text: content }],
    requestId,
    createdAt: Date.now(),
  };
}

function createStep(
  requestId: string,
  type: StepView["type"],
  status: StepView["status"],
  title: string,
): StepView {
  return {
    id: crypto.randomUUID(),
    requestId,
    type,
    status,
    title,
    startedAt: Date.now(),
  };
}

function buildStepTitle(mode: EmaMode): string {
  if (mode === "agent") {
    return "用 Ema 人设执行 Agent 回合";
  }
  if (mode === "narrative") {
    return "用 Ema 人设执行 Narrative 回合";
  }
  return "用 Ema 人设执行 Chat 回合";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
