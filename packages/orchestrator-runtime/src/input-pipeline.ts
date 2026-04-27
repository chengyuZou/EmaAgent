import type { ChatMessage, EmaMode, RuntimeInputEnvelope } from "@ema-agent/core-types";

export interface PrepareRuntimeInputRequest {
  rawUserQuery: string;
  recentMessages: ChatMessage[];
  mode: EmaMode;
}

export interface PreparedRuntimeInput {
  envelope: RuntimeInputEnvelope;
  recentMessages: ChatMessage[];
}

const RECENT_MESSAGE_LIMIT = 6;

export function prepareRuntimeInput(req: PrepareRuntimeInputRequest): PreparedRuntimeInput {
  const recentMessages = req.recentMessages.slice(-RECENT_MESSAGE_LIMIT);

  return {
    recentMessages,
    envelope: buildRuntimeInputEnvelope({
      rawUserQuery: req.rawUserQuery,
      recentMessages,
      mode: req.mode,
    }),
  };
}

export function buildRuntimeInputEnvelope(args: PrepareRuntimeInputRequest): RuntimeInputEnvelope {
  return {
    rawUserQuery: args.rawUserQuery,
    assembledUserPrompt: args.rawUserQuery,
    runtimeSystemPrompt: buildRuntimeSystemPrompt(args.recentMessages),
    contextBlocks: [],
    mode: args.mode,
  };
}

function buildRuntimeSystemPrompt(recentMessages: ChatMessage[]): string {
  // Ema 人设是所有模式的底座；agent 只是在这个底座上叠加工具执行规则。
  const emaPersona = "你是 Ema。保持 Ema 的语气、边界感和陪伴感，回答要直接、有执行力，但不要丢掉角色身份。";
  if (recentMessages.length === 0) {
    return `${emaPersona}\n当前是 TypeScript 最小闭环阶段。`;
  }

  return `${emaPersona}\n当前是 TypeScript 最小闭环阶段。\n最近消息数量：${recentMessages.length}。`;
}
