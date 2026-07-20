// 根据模型能力与线路协议生成单次调用快照，并在进入 Adapter 前拒绝不兼容输入。
import type { LlmProtocol, ModelCapabilitySnapshot } from '@ema-agent/provider';
import { LlmModelCapabilityError } from './errors.js';
import type { LlmCapabilityIssue } from './errors.js';
import { validateModelInputCapabilities } from './modelInputValidation.js';
import type {
  LlmContentPart,
  Message,
  LlmRequest,
  LlmToolDef,
  UserBlock,
} from './types.js';
import { validateContentParts } from './validate.js';

export interface PreparedLlmRequest extends LlmRequest {
  messages: Message[];
  tools?: LlmToolDef[];
}

interface LlmRequestPreparerDependencies {
  capabilitiesFor(providerId: string, model: string): ModelCapabilitySnapshot;
}

export class LlmRequestPreparer {
  constructor(private readonly dependencies: LlmRequestPreparerDependencies) {}

  prepare(request: LlmRequest, protocol: LlmProtocol): PreparedLlmRequest {
    const capabilities = this.dependencies.capabilitiesFor(request.providerId, request.model);
    const prepared = createRequestSnapshot(request, capabilities);
    const capabilityIssues: LlmCapabilityIssue[] = [
      ...validateModelInputCapabilities(prepared.messages, capabilities),
      ...validateModelFeatures(prepared, capabilities),
    ];
    if (capabilityIssues.length > 0) {
      throw new LlmModelCapabilityError(prepared.providerId, prepared.model, capabilityIssues);
    }

    const protocolIssues = validateProtocolMessages(prepared.messages, protocol);
    if (protocolIssues.length > 0) {
      throw new LlmModelCapabilityError(prepared.providerId, prepared.model, protocolIssues);
    }
    return prepared;
  }
}

function createRequestSnapshot(
  request: LlmRequest,
  capabilities: ModelCapabilitySnapshot,
): PreparedLlmRequest {
  const maxTokens = request.maxTokens !== undefined && capabilities.maxOutput !== undefined
    ? Math.min(request.maxTokens, capabilities.maxOutput)
    : request.maxTokens;
  const tools = request.tools?.map((tool) => ({
    ...tool,
    parameters: structuredClone(tool.parameters),
  }));

  return {
    ...request,
    messages: request.messages.map(cloneMessage),
    ...(tools ? { tools } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(request.thinking ? { thinking: { ...request.thinking } } : {}),
    ...(request.usageContext ? { usageContext: { ...request.usageContext } } : {}),
  };
}

function cloneMessage(message: Message): Message {
  if (message.role === 'system') return { ...message };
  if (message.role === 'assistant') {
    return { ...message, content: message.content.map((block) => ({ ...block })) };
  }
  if (typeof message.content === 'string') return { ...message };
  return {
    ...message,
    content: message.content.map(cloneUserBlock),
  };
}

function cloneUserBlock(block: UserBlock): UserBlock {
  if (block.type !== 'tool_result') return { ...block };
  return {
    ...block,
    content: typeof block.content === 'string'
      ? block.content
      : block.content.map((part) => ({ ...part })),
  };
}

function validateProtocolMessages(
  messages: readonly Message[],
  protocol: LlmProtocol,
): Array<{
  kind: 'input';
  messageIndex: number;
  partIndex: number;
  modality: 'image' | 'audio' | 'file';
  state: 'unsupported';
  reason: string;
}> {
  const issues: Array<{
    kind: 'input';
    messageIndex: number;
    partIndex: number;
    modality: 'image' | 'audio' | 'file';
    state: 'unsupported';
    reason: string;
  }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return;
    const parts = message.content.filter(
      (block): block is LlmContentPart => block.type !== 'tool_result',
    );
    for (const issue of validateContentParts(parts, protocol)) {
      const type = issue.part.type;
      const modality = type === 'audio_data'
        ? 'audio'
        : type === 'file_data' || type === 'file_url'
          ? 'file'
          : 'image';
      issues.push({
        kind: 'input',
        messageIndex,
        partIndex: issue.index,
        modality,
        state: 'unsupported',
        reason: issue.reason,
      });
    }
  });
  return issues;
}

function validateModelFeatures(
  request: PreparedLlmRequest,
  capabilities: ModelCapabilitySnapshot,
): LlmCapabilityIssue[] {
  const issues: LlmCapabilityIssue[] = [];
  if (request.tools?.length && capabilities.tools === 'unsupported') {
    issues.push({
      kind: 'feature',
      feature: 'tools',
      state: 'unsupported',
      reason: 'Model does not support tool calling',
    });
  }
  if (request.thinking?.enabled === true && capabilities.reasoning === 'unsupported') {
    issues.push({
      kind: 'feature',
      feature: 'reasoning',
      state: 'unsupported',
      reason: 'Model does not support explicit reasoning mode',
    });
  }
  return issues;
}
