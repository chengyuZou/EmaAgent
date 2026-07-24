// 全量压缩后恢复 Chat 角色连续性所需的情绪状态。
import type { SessionId } from '@ema-agent/ids';
import type { Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/turn';

export interface PostCompactionRestoreContext {
  sessionId: SessionId;
  executionProfile: ExecutionProfile;
}

export function buildPostCompactionRestore(
  loadSessionNote: ((sessionId: SessionId) => string | null) | undefined,
  context: PostCompactionRestoreContext,
): Message[] {
  if (context.executionProfile === 'work') return [];

  const noteMarkdown = loadSessionNote?.(context.sessionId);
  if (!noteMarkdown) return [];
  return restoreSection(noteMarkdown, ['Current Emotional State']);
}

function restoreSection(
  noteMarkdown: string,
  headings: readonly string[],
): Message[] {
  const section = headings
    .map(heading => extractLatestMarkdownSection(noteMarkdown, heading))
    .find((value): value is string => value !== null);
  if (!section) return [];

  return [{
    role: 'user',
    content: `<post-compact-restore profile="chat">\n${section}\n</post-compact-restore>`,
  }];
}

function extractLatestMarkdownSection(body: string, heading: string): string | null {
  const matches: string[] = [];
  let active = false;
  let captured: string[] = [];

  const flush = (): void => {
    const text = captured.join('\n').trim();
    if (text) matches.push(text);
    captured = [];
  };

  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line)) {
      if (active) flush();
      active = line.replace(/^##\s+/, '').trim() === heading;
    } else if (active) {
      captured.push(line);
    }
  }
  if (active) flush();
  return matches.at(-1) ?? null;
}
