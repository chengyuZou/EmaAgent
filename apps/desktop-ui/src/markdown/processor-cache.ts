/**
 * Markdown processor cache — stub (Shiki removed due to install issues).
 *
 * Full syntax highlighting will be added back once `@shikijs/rehype` is available
 * or the `rehype-shiki` git dependency issue is resolved upstream.
 */

export interface MarkdownProcessor {
  process(source: string): Promise<string>;
}

/** Always returns empty — no code blocks to detect. */
export function extractLangs(_markdown: string): string[] {
  return [];
}

/** Returns a no-op processor. */
export async function getProcessor(_langs: string[]): Promise<MarkdownProcessor> {
  return fallbackProcessor();
}

const _fallback: MarkdownProcessor = {
  async process(source: string): Promise<string> {
    return source;
  },
};

export function fallbackProcessor(): MarkdownProcessor {
  return _fallback;
}

export function clearProcessorCache(): void {
  // no-op
}
