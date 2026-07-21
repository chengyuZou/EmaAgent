// 重建全量压缩后容易丢失的近期文件、情绪与剧情状态上下文。
import type { SessionId, TurnMode } from '@ema-agent/contracts';
import type { Message } from '@ema-agent/llm';

const AGENT_MAX_FILES = 5;
const AGENT_FILE_TOKEN_BUDGET = 5_000;
const AGENT_TOTAL_TOKEN_BUDGET = 25_000;
const CHAR_PER_TOKEN = 4;

export interface PostCompactionRestoreContext {
  sessionId: SessionId;
  mode: TurnMode;
  recentFiles?: ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
}

export function buildPostCompactionRestore(
  loadSessionNote: ((sessionId: SessionId) => string | null) | undefined,
  context: PostCompactionRestoreContext,
): Message[] {
  if (context.mode === 'agent') return restoreRecentFiles(context);

  const noteMarkdown = loadSessionNote?.(context.sessionId);
  if (!noteMarkdown) return [];
  return context.mode === 'chat'
    ? restoreSection(noteMarkdown, 'chat', ['Current Emotional State'])
    : restoreSection(noteMarkdown, 'narrative', ['Current Scene', 'Active Timeline']);
}

function restoreRecentFiles(context: PostCompactionRestoreContext): Message[] {
  const files = [...(context.recentFiles ?? [])].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const sections: string[] = [];
  let totalTokens = 0;

  for (const file of files.slice(0, AGENT_MAX_FILES)) {
    if (totalTokens >= AGENT_TOTAL_TOKEN_BUDGET) break;
    const tokenCap = Math.min(
      AGENT_FILE_TOKEN_BUDGET,
      AGENT_TOTAL_TOKEN_BUDGET - totalTokens,
    );
    const charCap = tokenCap * CHAR_PER_TOKEN;
    const content = file.content.length > charCap
      ? `${file.content.slice(0, charCap)}\n\n[内容已截断，请用 Read 重新读取完整文件]`
      : file.content;

    sections.push(`### \`${file.path}\`\n\n\`\`\`\n${content}\n\`\`\``);
    totalTokens += Math.ceil(content.length / CHAR_PER_TOKEN);
  }

  if (sections.length === 0) return [];
  return [{
    role: 'user',
    content: `<post-compact-restore mode="agent">\n以下是压缩前最近读取的文件快照。需要最新或完整内容时请重新调用 Read。\n\n${sections.join('\n\n')}\n</post-compact-restore>`,
  }];
}

function restoreSection(
  noteMarkdown: string,
  mode: 'chat' | 'narrative',
  headings: readonly string[],
): Message[] {
  const section = headings
    .map(heading => extractLatestMarkdownSection(noteMarkdown, heading))
    .find((value): value is string => value !== null);
  if (!section) return [];

  return [{
    role: 'user',
    content: `<post-compact-restore mode="${mode}">\n${section}\n</post-compact-restore>`,
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
