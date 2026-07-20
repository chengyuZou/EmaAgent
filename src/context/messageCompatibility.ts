// 为历史消息生成兼容视图，并对本轮输入执行不可静默降级的能力校验。
import type {
  ContentPart,
  Message,
  ToolResultContentPart,
  UserBlock,
} from '@ema-agent/llm';
import type { ModelCapabilitySnapshot, ModelCapabilityState } from '@ema-agent/provider';

export type InputModality = 'image' | 'audio' | 'file';

export interface MessageCompatibilityIssue {
  kind: 'input';
  messageIndex: number;
  partIndex: number;
  nestedPartIndex?: number;
  modality: InputModality;
  state: Exclude<ModelCapabilityState, 'supported'>;
  reason: string;
}

export interface MessageCompatibilityAction extends MessageCompatibilityIssue {
  replacement: 'description' | 'placeholder';
}

export interface CompatibleMessageView {
  messages: Message[];
  actions: MessageCompatibilityAction[];
}

/**
 * 为历史消息创建只读兼容视图。原始 Session blocks 与传入数组均不修改。
 * 历史媒体没有可靠描述字段时使用明确占位，禁止伪装成模型已经看过内容。
 */
export function prepareHistoricalMessageView(
  messages: readonly Message[],
  capabilities: ModelCapabilitySnapshot,
): CompatibleMessageView {
  const actions: MessageCompatibilityAction[] = [];
  const next = messages.map((message, messageIndex): Message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return cloneMessage(message);

    const content: UserBlock[] = message.content.map((block, partIndex) => {
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return { ...block };
        return {
          ...block,
          content: block.content.map((part, nestedPartIndex) => replaceHistoricalPart(
            part,
            capabilities,
            actions,
            messageIndex,
            partIndex,
            nestedPartIndex,
          )),
        };
      }
      const part = block;
      return replaceHistoricalPart(
        part,
        capabilities,
        actions,
        messageIndex,
        partIndex,
      );
    });
    return { ...message, content };
  });

  return { messages: next, actions };
}

/** 本轮新内容必须得到明确支持；unknown 也不能静默发送。 */
export function validateCurrentContent(
  parts: readonly ContentPart[],
  capabilities: ModelCapabilitySnapshot,
): MessageCompatibilityIssue[] {
  return validateParts(parts, capabilities, 0);
}

function validateParts(
  parts: readonly ContentPart[],
  capabilities: ModelCapabilitySnapshot,
  messageIndex: number,
): MessageCompatibilityIssue[] {
  const issues: MessageCompatibilityIssue[] = [];
  parts.forEach((part, partIndex) => {
    const issue = validatePart(part, capabilities, messageIndex, partIndex);
    if (issue) issues.push(issue);
  });
  return issues;
}

function validatePart(
  part: ContentPart | ToolResultContentPart,
  capabilities: ModelCapabilitySnapshot,
  messageIndex: number,
  partIndex: number,
  nestedPartIndex?: number,
): MessageCompatibilityIssue | undefined {
  const modality = modalityOf(part);
  if (!modality) return undefined;
  const state = capabilities.input[modality];
  if (state === 'supported') return undefined;
  return {
    kind: 'input',
    messageIndex,
    partIndex,
    ...(nestedPartIndex !== undefined ? { nestedPartIndex } : {}),
    modality,
    state,
    reason: state === 'unknown'
      ? `Model capability for ${modality} input is unknown`
      : `Model does not support ${modality} input`,
  };
}

function replaceHistoricalPart<T extends ContentPart | ToolResultContentPart>(
  part: T,
  capabilities: ModelCapabilitySnapshot,
  actions: MessageCompatibilityAction[],
  messageIndex: number,
  partIndex: number,
  nestedPartIndex?: number,
): T | { type: 'text'; text: string } {
  const modality = modalityOf(part);
  if (!modality) return { ...part };
  const state = capabilities.input[modality];
  if (state === 'supported') return { ...part };

  const reason = state === 'unknown'
    ? `当前模型的 ${modality} 输入能力未知`
    : `当前模型不支持 ${modality} 输入`;
  actions.push({
    kind: 'input',
    messageIndex,
    partIndex,
    ...(nestedPartIndex !== undefined ? { nestedPartIndex } : {}),
    modality,
    state,
    reason,
    replacement: 'placeholder',
  });
  return { type: 'text', text: historicalPlaceholder(modality, part) };
}

function modalityOf(part: ContentPart | ToolResultContentPart): InputModality | undefined {
  if (part.type === 'image_data' || part.type === 'image_url') return 'image';
  if (part.type === 'audio_data') return 'audio';
  if (part.type === 'file_data' || part.type === 'file_url') return 'file';
  return undefined;
}

function historicalPlaceholder(
  modality: InputModality,
  part: ContentPart | ToolResultContentPart,
): string {
  const name = 'name' in part && typeof part.name === 'string'
    ? `“${part.name}”`
    : 'filename' in part && typeof part.filename === 'string'
      ? `“${part.filename}”`
      : '';
  const labels: Record<InputModality, string> = {
    image: '图片',
    audio: '音频',
    file: '附件',
  };
  return `[历史${labels[modality]}${name}未发送：当前模型不支持该输入，且没有可用描述]`;
}

function cloneMessage(message: Message): Message {
  switch (message.role) {
    case 'system':
      return { ...message };
    case 'user':
      return typeof message.content === 'string'
        ? { ...message }
        : {
            ...message,
            content: message.content.map((block) => block.type === 'tool_result'
              ? {
                  ...block,
                  content: typeof block.content === 'string'
                    ? block.content
                    : block.content.map((part) => ({ ...part })),
                }
              : { ...block }),
          };
    case 'assistant':
      return { ...message, content: message.content.map((block) => ({ ...block })) };
  }
}
