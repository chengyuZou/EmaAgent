// 根据 Session 的第一条用户消息生成短标题，并在模型不可用时使用确定性回退。
import type { SessionId } from '@ema-agent/ids';
import type { Message } from './types.js';
import type { MessageBlocks } from './message.js';

const TITLE_PROMPT = `Generate a very short title (3–6 words, no quotes) that captures the topic of the following message. Reply with only the title.\n\nMessage: `;
const TITLE_MAX_CHARS = 60;
const TITLE_INPUT_MAX_CHARS = 400;

interface SessionTitleStore {
  listMessages(sessionId: SessionId, input: { limit: number }): Message[];
  patchSession(sessionId: SessionId, patch: { title: string }): void;
}

export interface SessionTitleCompletionPort {
  completeTitle(prompt: string): Promise<string | undefined>;
}

export class SessionTitleGenerator {
  constructor(
    private readonly session: SessionTitleStore,
    private readonly completion: SessionTitleCompletionPort,
  ) {}

  async generate(sessionId: SessionId): Promise<string | undefined> {
    const messages = this.session.listMessages(sessionId, { limit: 10 });
    const firstUser = messages.find((message) => message.role === 'user');
    if (!firstUser) return undefined;

    const firstText = extractText(firstUser.blocks);
    if (!firstText) return undefined;

    let title: string | undefined;
    try {
      title = await this.completion.completeTitle(
        TITLE_PROMPT + firstText.slice(0, TITLE_INPUT_MAX_CHARS),
      );
    } catch {
      // 标题生成不能阻断会话；模型失败时仍给用户一个可用的确定性标题。
    }

    const normalized = normalizeGeneratedTitle(title) ?? truncateTitle(firstText);
    this.session.patchSession(sessionId, { title: normalized });
    return normalized;
  }
}

function extractText(blocks: MessageBlocks): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const part = blocks.find((block) => block.type === 'text');
  return part?.text ?? '';
}

function normalizeGeneratedTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^["']|["']$/g, '');
  if (!normalized) return undefined;
  return normalized.slice(0, TITLE_MAX_CHARS);
}

function truncateTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length <= TITLE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, TITLE_MAX_CHARS - 1)}…`;
}
