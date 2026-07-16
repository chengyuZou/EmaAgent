// 这里负责把可重新获取的超大工具输出落盘，只在模型上下文中保留预览和引用。
import * as fs     from 'node:fs';
import * as path   from 'node:path';
import { createHash } from 'node:crypto';

// ── AgentToolResultStore ──────────────────────────────────────────────────────
//
// Offloads large tool outputs to disk instead of stuffing them into the
// message history. The tool_result block keeps a preview + file reference;
// the full content lives in {sessionDir}/tool-results/{hash}.
//
// Storage layout (per session, so deleting a session removes everything):
//   {dataDir}/.ema-agent/sessions/{sessionId}/tool-results/{hash(callId)}
//
// Only "re-fetchable" command-style outputs are offloaded (Bash/Grep/WebFetch 等)。
// NOT offloaded:
//   - Read     → file content IS the point of reading; truncating to a 2KB
//                preview would starve the model of the file it's editing.
//                Read does its own pagination / size limits.
//   - Artifact 工具 / AskUser → self-managed storage or unique state.

/** 输出可以重新获取的工具；Read 故意不在这里。 */
export const OFFLOADABLE_TOOLS = new Set<string>([
  'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch',
]);

const DEFAULT_OFFLOAD_THRESHOLD = 50 * 1024;  // 50 KB
const PREVIEW_BYTES             = 2000;

const PERSISTED_OPEN  = '<persisted-output>';
const PERSISTED_CLOSE = '</persisted-output>';

/**
 * Discriminated result of maybeNormalize():
 *   - 'unchanged' → keep the original tool_result content as-is
 *   - 'placeholder' → replace content (empty-output normalization, no file)
 *   - 'offloaded' → replace content with preview, full output on disk at filePath
 */
export type NormalizeResult =
  | { kind: 'unchanged' }
  | { kind: 'placeholder'; blockContent: string }
  | { kind: 'offloaded'; blockContent: string; filePath: string; originalSize: number };

export class AgentToolResultStore {
  /** @param toolResultsDir absolute path: {dataDir}/.ema-agent/sessions/{sessionId}/tool-results */
  constructor(
    private readonly toolResultsDir: string,
    private readonly threshold: number = DEFAULT_OFFLOAD_THRESHOLD,
  ) {}

  /**
   * Decide how a tool result should be represented in the message history.
   *
   *   empty content                → placeholder (some models emit a stop
   *                                   sequence on a bare empty tool_result)
   *   offloadable tool + too large → offload to disk, return preview block
   *   otherwise                    → unchanged
   */
  maybeNormalize(callId: string, toolName: string, content: string): NormalizeResult {
    if (content.trim() === '') {
      return { kind: 'placeholder', blockContent: `(${toolName} completed with no output)` };
    }

    if (!OFFLOADABLE_TOOLS.has(toolName)) return { kind: 'unchanged' };
    if (Buffer.byteLength(content, 'utf8') <= this.threshold) return { kind: 'unchanged' };

    fs.mkdirSync(this.toolResultsDir, { recursive: true });
    const filePath = this.pathFor(callId);

    // hash(callId) is unique and content is deterministic for it — skip rewrite
    // if the file exists (compaction replays the same messages each turn).
    try {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { kind: 'unchanged' }; // write failed — keep original content
      }
      // EEXIST: already persisted on a prior turn, fall through to preview
    }

    const { preview, hasMore } = generatePreview(content, PREVIEW_BYTES);
    const sizeKb = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);
    const blockContent =
      `${PERSISTED_OPEN}\n` +
      `Output too large (${sizeKb} KB). Full output saved to: ${filePath}\n\n` +
      `Preview (first ${PREVIEW_BYTES} bytes):\n${preview}${hasMore ? '\n...\n' : '\n'}` +
      PERSISTED_CLOSE;

    return { kind: 'offloaded', blockContent, filePath, originalSize: content.length };
  }

  /** Read a previously offloaded result. Returns null if the file is gone. */
  read(callId: string): string | null {
    try {
      return fs.readFileSync(this.pathFor(callId), 'utf8');
    } catch {
      return null; // cleaned up or never existed — caller degrades gracefully
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  // callId comes off the provider stream — never trust it as a path segment.
  // Hash to a fixed-length hex name so a crafted id can't escape the dir.
  private pathFor(callId: string): string {
    const safe = createHash('sha256').update(callId).digest('hex').slice(0, 32);
    return path.join(this.toolResultsDir, safe);
  }
}

// ── Preview helper (truncate at newline boundary) ─────────────────────────────

export function generatePreview(content: string, maxBytes: number): { preview: string; hasMore: boolean } {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { preview: content, hasMore: false };
  }
  const truncated  = content.slice(0, maxBytes);
  const lastNl     = truncated.lastIndexOf('\n');
  const cutPoint   = lastNl > maxBytes * 0.5 ? lastNl : maxBytes;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}
