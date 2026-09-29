// 验证 Mermaid 使用官方围栏 token 识别流式闭合, 保持绘图身份与原有 Markdown 安全边界.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../components/Markdown.js';

const drawing = vi.hoisted(() => ({
  render: vi.fn(),
  appearance: {
    dark: true, fontFamily: 'sans-serif', text: '#eeeeee', secondaryText: '#bbbbbb',
    background: '#222222', node: '#183b45', nodeBorder: '#38a6c2', line: '#888888', cluster: '#242428',
  },
}));

vi.mock('../components/mermaidRender.js', () => ({
  renderMermaid: drawing.render,
  readMermaidAppearance: () => drawing.appearance,
}));

let container: HTMLDivElement;
let root: Root;
const graph = 'flowchart TD\n  A[开始] --> B[结束]';
const closed = `\`\`\`mermaid\n${graph}\n\`\`\``;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  drawing.render.mockReset().mockResolvedValue('<svg viewBox="0 0 100 100"><text>已渲染</text></svg>');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(source: string, streaming = false): Promise<void> {
  await act(async () => root.render(<Markdown source={source} streaming={streaming} />));
}

describe('Markdown Mermaid', () => {
  it('renders static Mermaid without syntax highlighting its source', async () => {
    await show(closed);
    expect(drawing.render).toHaveBeenCalledTimes(1);
    expect(drawing.render.mock.calls[0][1]).toBe(graph);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.hljs')).toBeNull();
  });

  it('waits for the closing fence, then keeps the completed graph while later text streams', async () => {
    await show(`\`\`\`mermaid\n${graph}`, true);
    expect(drawing.render).not.toHaveBeenCalled();
    expect(container.textContent).toContain('等待图表生成完整');
    await show(closed, true);
    expect(drawing.render).toHaveBeenCalledTimes(1);
    await show(`${closed}\n\n后续正文继续生成`, true);
    await show(`${closed}\n\n后续正文继续生成完成`, false);
    expect(drawing.render).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['blockquote', '> ~~~mermaid\n> flowchart TD\n> A --> B\n> ~~~'],
    ['list', '- 图表\n\n  ```mermaid\n  flowchart TD\n  A --> B\n  ```'],
    ['long fence', '````mermaid\nflowchart TD\nA --> B\n````'],
  ])('recognizes closed %s fences through the parser', async (_name, source) => {
    await show(source, true);
    expect(drawing.render).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a shorter or different fence for a closing fence', async () => {
    await show('````mermaid\nflowchart TD\nA --> B\n```', true);
    expect(drawing.render).not.toHaveBeenCalled();
    await show('```mermaid\nflowchart TD\nA --> B\n~~~', true);
    expect(drawing.render).not.toHaveBeenCalled();
  });

  it('still renders an EOF-terminated graph once the message is no longer streaming', async () => {
    await show(`\`\`\`mermaid\n${graph}`, false);
    expect(drawing.render).toHaveBeenCalledTimes(1);
  });

  it('uses the shared source toggle without redrawing the graph', async () => {
    await show(closed);
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('pre code')?.textContent).toBe(graph);
    expect(container.querySelector('.markdown-mermaid-diagram')?.hasAttribute('hidden')).toBe(true);
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('pre')).toBeNull();
    expect(drawing.render).toHaveBeenCalledTimes(1);
  });

  it('shows readable source when official rendering fails', async () => {
    drawing.render.mockResolvedValue(null);
    await show(closed);
    expect(container.querySelector('pre code')?.textContent).toBe(graph);
    expect(container.textContent).toContain('请检查语法');
    expect(container.querySelector('.markdown-mermaid')?.getAttribute('aria-busy')).toBe('false');
  });

  it('does not draw a graph that has not approached the viewport', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    });
    await show(closed);
    expect(drawing.render).not.toHaveBeenCalled();
  });

  it('does not let an older asynchronous result replace changed source', async () => {
    let finishOld!: (svg: string) => void;
    drawing.render.mockImplementationOnce(() => new Promise<string>(resolve => { finishOld = resolve; }));
    await show(closed);
    await show(closed.replace('结束', '新终点'));
    await act(async () => finishOld('<svg><text>过时的图</text></svg>'));
    expect(container.textContent).toContain('已渲染');
    expect(container.textContent).not.toContain('过时的图');
  });

  it('preserves normal code, math, links and raw HTML sanitization', async () => {
    await show('```ts\nconst a = 1;\n```\n\n$x^2$\n\n[网站](https://example.com)\n\n<div style="position:fixed" onclick="alert(1)">正文</div><script>alert(1)</script>');
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('script, div[style], [onclick]')).toBeNull();
    expect(drawing.render).not.toHaveBeenCalled();
  });

  it('supports server rendering without measuring DOM or importing the drawing engine', () => {
    expect(renderToStaticMarkup(<Markdown source={closed} />)).toContain('language-mermaid');
    expect(drawing.render).not.toHaveBeenCalled();
  });
});
