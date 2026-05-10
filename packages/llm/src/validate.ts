import type { MessageContentPart } from '@ema-agent/contracts';
import type { LlmProvider } from './types.js';

export interface UnsupportedPart {
  index: number;
  part: MessageContentPart;
  reason: string;
}

/**
 * Check which content parts are incompatible with the given provider.
 *
 * Call this before startTurn() and surface the result to the user so they can
 * choose to remove the offending parts or cancel. Do NOT throw on incompatibility
 * — that would kill the whole turn for a single bad attachment.
 *
 * Returns an empty array when everything is compatible.
 */
export function validateContentParts(
  parts: MessageContentPart[],
  provider: LlmProvider,
): UnsupportedPart[] {
  const issues: UnsupportedPart[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const issue = checkPart(part, provider);
    if (issue) issues.push({ index: i, part, reason: issue });
  }

  return issues;
}

function checkPart(part: MessageContentPart, provider: LlmProvider): string | null {
  switch (provider) {
    case 'openai':
    case 'openai-compat':
      return checkOpenAi(part);
    case 'anthropic':
      return checkAnthropic(part);
    case 'gemini':
      return checkGemini(part);
  }
}

function checkOpenAi(part: MessageContentPart): string | null {
  if (part.type === 'file_data' || part.type === 'file_url') {
    return 'OpenAI does not support inline file attachments — use the Files API separately';
  }
  if (part.type === 'audio_data') {
    const ok = part.mimeType === 'audio/wav'
            || part.mimeType === 'audio/mp3'
            || part.mimeType === 'audio/mpeg';
    if (!ok) return `OpenAI audio only accepts wav/mp3, got "${part.mimeType}"`;
  }
  return null;
}

function checkAnthropic(part: MessageContentPart): string | null {
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

function checkGemini(part: MessageContentPart): string | null {
  // Gemini handles everything via inlineData; the only caveat is image_url / file_url
  // which require GCS or Files API URIs — plain https:// will fail at runtime.
  if (part.type === 'image_url' || part.type === 'file_url') {
    if (!part.url.startsWith('gs://')) {
      return 'Gemini only accepts gs:// or Files API URIs for URL-based content — download the file and use image_data / file_data instead';
    }
  }
  return null;
}
