// 验证绘图按需加载、串行主题初始化、50 项缓存与测量节点清理, 不在 JSDOM 模拟 ELK 算法.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidAppearance } from '../components/mermaidRender.js';
import type { LayoutLoaderDefinition } from 'mermaid';

const engine = vi.hoisted(() => ({
  registerLayoutLoaders: vi.fn(),
  initialize: vi.fn(),
  render: vi.fn(),
  elkRender: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('mermaid', () => ({ default: engine }));
vi.mock('@mermaid-js/layout-elk', () => ({
  default: [{ name: 'elk', algorithm: 'elk.layered', loader: async () => ({ render: engine.elkRender }) }],
}));

const theme: MermaidAppearance = {
  dark: true, fontFamily: 'sans-serif', text: '#eeeeee', secondaryText: '#bbbbbb',
  background: '#222222', node: '#183b45', nodeBorder: '#38a6c2', line: '#888888', cluster: '#242428',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  engine.render.mockReset().mockResolvedValue({ svg: '<svg />' });
});

describe('Mermaid rendering queue', () => {
  it('loads only on first draw, registers official ELK and reuses a same-instance promise', async () => {
    const { renderMermaid } = await import('../components/mermaidRender.js');
    expect(engine.registerLayoutLoaders).not.toHaveBeenCalled();
    const first = renderMermaid('one', 'flowchart TD; A-->B', theme);
    expect(renderMermaid('one', 'flowchart TD; A-->B', { ...theme })).toBe(first);
    await first;
    expect(engine.registerLayoutLoaders).toHaveBeenCalledTimes(1);
    expect(engine.registerLayoutLoaders.mock.calls[0][0][0]).toMatchObject({ name: 'elk', algorithm: 'elk.layered' });
    expect(engine.initialize).toHaveBeenCalledWith(expect.objectContaining({
      layout: 'elk', theme: 'base', securityLevel: 'strict', htmlLabels: false,
      flowchart: expect.objectContaining({ nodeSpacing: 32, rankSpacing: 44 }),
    }));
    expect(engine.render).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.markdown-mermaid-measure')).toBeNull();
  });

  it('does not initialize a second theme while the first draw is measuring', async () => {
    const { renderMermaid } = await import('../components/mermaidRender.js');
    let finish!: (result: { svg: string }) => void;
    engine.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = renderMermaid('one', 'flowchart TD; A-->B', theme);
    const second = renderMermaid('two', 'flowchart TD; C-->D', { ...theme, dark: false });
    await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(1));
    expect(engine.initialize).toHaveBeenCalledTimes(1);
    finish({ svg: '<svg />' });
    await Promise.all([first, second]);
    expect(engine.initialize).toHaveBeenCalledTimes(2);
    expect(engine.initialize.mock.calls[1][0].darkMode).toBe(false);
  });

  it.each(['flowchart', 'flowchart-v2', 'flowchart-elk'])('customizes %s through the official loader without replacing its render algorithm', async type => {
    const { renderMermaid } = await import('../components/mermaidRender.js');
    await renderMermaid('one', 'flowchart TD; A-->B', theme);
    const layout = engine.registerLayoutLoaders.mock.calls[0][0][0] as LayoutLoaderDefinition;
    const renderer = await layout.loader();
    const data: Parameters<typeof renderer.render>[0] = {
      type, config: {}, edges: [],
      nodes: [
        { id: 'A', isGroup: false, shape: 'rect' },
        { id: 'B', isGroup: false, shape: 'question' },
        { id: 'C', isGroup: false, shape: 'circle' },
        { id: 'D', isGroup: true, shape: 'rect' },
      ],
    };
    // 这里只检查包装层传给官方实现的数据与箭头样式, 不用假的尺寸测试布局质量.
    const markers = { attr: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis() };
    const svg = { selectAll: vi.fn(() => markers) } as unknown as Parameters<typeof renderer.render>[1];
    const helpers = {} as Parameters<typeof renderer.render>[2];
    await renderer.render(data, svg, helpers, { algorithm: 'elk.layered' });
    expect(engine.elkRender).toHaveBeenCalledWith(data, svg, helpers, { algorithm: 'elk.layered' });
    expect(data.nodes[0]).toMatchObject({ height: 52, padding: 16, labelPaddingX: 24 });
    expect(data.nodes[1]).toMatchObject({ shape: 'rect', cssClasses: expect.stringContaining('ema-mermaid-decision') });
    expect(data.nodes[2].shape).toBe('circle');
    expect(data.nodes[3].padding).toBeUndefined();
    expect(markers.attr).toHaveBeenCalledWith('d', 'M 2 1 L 7 5 L 2 9');
  });

  it('uses unique SVG ids when source or theme changes and separate ids for repeated graph instances', async () => {
    const { renderMermaid } = await import('../components/mermaidRender.js');
    await renderMermaid('one', 'flowchart TD; A-->B', theme);
    await renderMermaid('one', 'flowchart TD; A-->B', { ...theme, node: '#445566' });
    await renderMermaid('two', 'flowchart TD; A-->B', theme);
    const ids = engine.render.mock.calls.map(call => call[0]);
    expect(new Set(ids).size).toBe(3);
  });

  it('caches a failed draw, removes measurement nodes and keeps the next graph usable', async () => {
    const { renderMermaid } = await import('../components/mermaidRender.js');
    engine.render.mockRejectedValueOnce(new Error('invalid grammar'));
    expect(await renderMermaid('one', 'invalid', theme)).toBeNull();
    expect(await renderMermaid('one', 'invalid', theme)).toBeNull();
    expect(await renderMermaid('two', 'flowchart TD; C-->D', theme)).toBe('<svg />');
    expect(engine.render).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.markdown-mermaid-measure')).toBeNull();
  });

  it('evicts old entries after 50 graphs instead of retaining every opened file forever', async () => {
    const { renderMermaid } = await import('../components/mermaidRender.js');
    for (let index = 0; index < 51; index += 1) {
      await renderMermaid(`file-${index}`, 'flowchart TD; A-->B', theme);
    }
    await renderMermaid('file-50', 'flowchart TD; A-->B', theme);
    expect(engine.render).toHaveBeenCalledTimes(51);
    await renderMermaid('file-0', 'flowchart TD; A-->B', theme);
    expect(engine.render).toHaveBeenCalledTimes(52);
  });
});
