// 检查消息内容是否满足目标 LLM 协议支持的输入类型。
import type { ContentPart } from './message.js';
import type { LlmProtocol } from './types.js';

export interface UnsupportedPart {
  index: number;
  part: ContentPart;
  reason: string;
}

/**
 * 检查哪些 content part 与给定 provider 不兼容。
 *
 * 在 startTurn() 前调用,把结果呈现给用户,让其选择移除违规 part 或取消。
 * 不要在 incompatible 时抛错 - 那会因单个坏附件杀掉整个 turn。
 *
 * 全部兼容时返回空数组。
 */
export function validateContentParts(
  parts: ContentPart[],
  provider: LlmProtocol,
): UnsupportedPart[] {
  const issues: UnsupportedPart[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const issue = checkPart(part, provider);
    if (issue) issues.push({ index: i, part, reason: issue });
  }

  return issues;
}

function checkPart(part: ContentPart, provider: LlmProtocol): string | null {
  switch (provider) {
    case 'openai-llm':
    case 'openai-responses-llm':
      // Responses API 与 Chat Completions 共享相同 content-part 规则。
      // audio_data 技术上受支持(mp3/wav),但 adapter 会静默丢弃 -
      // 在此警告调用方,让其在上层处理。
      return checkOpenAi(part);
    case 'anthropic-llm': return checkAnthropic(part);
    case 'gemini-llm':    return checkGemini(part);
  }
}

function checkOpenAi(part: ContentPart): string | null {
  if (part.type === 'file_data' || part.type === 'file_url') {
    return 'OpenAI does not support inline file attachments - use the Files API separately';
  }
  if (part.type === 'audio_data') {
    const ok = part.mimeType === 'audio/wav'
            || part.mimeType === 'audio/mp3'
            || part.mimeType === 'audio/mpeg';
    if (!ok) return `OpenAI audio only accepts wav/mp3, got "${part.mimeType}"`;
  }
  return null;
}

function checkAnthropic(part: ContentPart): string | null {
  if (part.type === 'audio_data') {
    return 'Anthropic does not support audio input';
  }
  if (part.type === 'image_data') {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(part.mimeType)) {
      return `Anthropic image only accepts jpeg/png/gif/webp, got "${part.mimeType}"`;
    }
  }
  return null;
}

function checkGemini(part: ContentPart): string | null {
  // Gemini 一切走 inlineData;唯一坑是 image_url / file_url
  // 需要 GCS 或 Files API URI - 纯 https:// 运行时会失败。
  if (part.type === 'image_url' || part.type === 'file_url') {
    if (!part.url.startsWith('gs://')) {
      return 'Gemini only accepts gs:// or Files API URIs for URL-based content - download the file and use image_data / file_data instead';
    }
  }
  return null;
}
