// 在进入协议 Adapter 前检查所有模型可见媒体，防止 Hook 或 Tool 绕过上层 Context 门禁。
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';
import type { LlmCapabilityIssue } from './errors.js';
import type {
  ContentPart,
  Message,
  ToolResultContentPart,
} from './message.js';

export function validateModelInputCapabilities(
  messages: readonly Message[],
  capabilities: ModelCapabilitySnapshot,
): LlmCapabilityIssue[] {
  const issues: LlmCapabilityIssue[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return;

    message.content.forEach((block, partIndex) => {
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return;
        for (const part of block.content) {
          const issue = validatePart(part, capabilities, messageIndex, partIndex);
          if (issue) issues.push(issue);
        }
        return;
      }

      const issue = validatePart(block, capabilities, messageIndex, partIndex);
      if (issue) issues.push(issue);
    });
  });

  return issues;
}

function validatePart(
  part: ContentPart | ToolResultContentPart,
  capabilities: ModelCapabilitySnapshot,
  messageIndex: number,
  partIndex: number,
): LlmCapabilityIssue | undefined {
  const modality = inputModalityOf(part);
  if (!modality) return undefined;

  const state = capabilities.input[modality];
  if (state === 'supported') return undefined;

  return {
    kind: 'input',
    messageIndex,
    partIndex,
    modality,
    state,
    reason: state === 'unknown'
      ? `Model capability for ${modality} input is unknown`
      : `Model does not support ${modality} input`,
  };
}

function inputModalityOf(
  part: ContentPart | ToolResultContentPart,
): 'image' | 'audio' | 'file' | undefined {
  if (part.type === 'image_data' || part.type === 'image_url') return 'image';
  if (part.type === 'audio_data') return 'audio';
  if (part.type === 'file_data' || part.type === 'file_url') return 'file';
  return undefined;
}
