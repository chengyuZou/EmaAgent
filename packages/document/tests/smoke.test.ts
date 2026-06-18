import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/parse.js';
import { HeadingChunker } from '../src/chunking/heading.js';
import { buildPreview } from '../src/preview.js';

const MD_FIXTURE = `
# Introduction

This is the introduction paragraph. It explains what this document is about.

## Background

Some background text here with more detail about the topic.

- First list item
- Second list item

## Code Example

\`\`\`typescript
function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

# Conclusion

Final thoughts.
`.trim();

describe('parseDocument (markdown)', () => {
  it('extracts elements with correct kinds', async () => {
    const doc = await parseDocument(
      { kind: 'bytes', bytes: new TextEncoder().encode(MD_FIXTURE), name: 'test.md' },
    );

    const kinds = doc.elements.map(e => e.kind);
    expect(kinds).toContain('title');
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('list_item');
    expect(kinds).toContain('code');
  });

  it('sets sectionPath on elements under headings', async () => {
    const doc = await parseDocument(
      { kind: 'bytes', bytes: new TextEncoder().encode(MD_FIXTURE), name: 'test.md' },
    );

    const backgroundPara = doc.elements.find(
      e => e.kind === 'paragraph' && e.sectionPath.includes('Background'),
    );
    expect(backgroundPara).toBeDefined();
    expect(backgroundPara!.sectionPath).toContain('Background');
  });

  it('counts words in meta', async () => {
    const doc = await parseDocument(
      { kind: 'bytes', bytes: new TextEncoder().encode(MD_FIXTURE), name: 'test.md' },
    );
    expect(doc.meta.wordCount).toBeGreaterThan(10);
    expect(doc.meta.title).toBe('Introduction');
  });
});

describe('HeadingChunker', () => {
  it('splits on title elements', async () => {
    const doc    = await parseDocument(
      { kind: 'bytes', bytes: new TextEncoder().encode(MD_FIXTURE), name: 'test.md' },
    );
    const chunks = await new HeadingChunker().chunk(doc.elements, { maxTokens: 512, overlap: 64, minTokens: 5 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toMatchObject({ tokenCount: expect.any(Number) });
  });

  it('wires prev/next links', async () => {
    const doc    = await parseDocument(
      { kind: 'bytes', bytes: new TextEncoder().encode(MD_FIXTURE), name: 'test.md' },
    );
    const chunks = await new HeadingChunker().chunk(doc.elements, { maxTokens: 512, overlap: 64, minTokens: 5 });

    if (chunks.length >= 2) {
      expect(chunks[0]!.next).toBe(chunks[1]!.id);
      expect(chunks[1]!.prev).toBe(chunks[0]!.id);
    }
  });
});

describe('buildPreview', () => {
  it('builds text preview from elements', async () => {
    const doc     = await parseDocument(
      { kind: 'bytes', bytes: new TextEncoder().encode(MD_FIXTURE), name: 'test.md' },
    );
    const preview = await buildPreview(doc.elements, { mimeType: 'text/markdown' });

    expect(preview.text.length).toBeGreaterThan(10);
    expect(preview.wordCount).toBeGreaterThan(5);
    expect(preview.thumbnail).toBeUndefined(); // no bytes supplied
  });
});
