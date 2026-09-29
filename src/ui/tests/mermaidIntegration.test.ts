// 跑真实 Mermaid + 官方 ELK 包, 仅替代 JSDOM 缺少的 SVG 文字测量; 外观仍需在浏览器验收.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderMermaid, type MermaidAppearance } from '../components/mermaidRender.js';

const theme: MermaidAppearance = {
  dark: true, fontFamily: 'sans-serif', text: '#eeeeee', secondaryText: '#bbbbbb',
  background: '#222222', node: '#183b45', nodeBorder: '#38a6c2', line: '#888888', cluster: '#242428',
};

beforeAll(() => {
  // 不用这些假尺寸声称视觉布局或性能通过, 只验证真实库能完成解析、ELK 布局与 SVG 输出.
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', {
    configurable: true,
    value: () => 100,
  });
});

afterAll(() => {
  delete (SVGElement.prototype as SVGElement & { getBBox?: () => DOMRect }).getBBox;
  delete (SVGElement.prototype as SVGElement & { getComputedTextLength?: () => number }).getComputedTextLength;
  vi.restoreAllMocks();
});

describe('Official Mermaid/ELK integration', () => {
  it('renders flowchart-v2 with themed decision nodes and open arrow heads', async () => {
    const svg = await renderMermaid('integration-flow', 'flowchart TD\nA[开始] --> B{允许?}\nB -->|是| C[执行]\nB -->|否| D[停止]', theme);
    expect(svg).not.toBeNull();
    const host = document.createElement('div');
    host.innerHTML = svg!;
    expect(host.querySelector('.node.ema-mermaid-decision rect')).not.toBeNull();
    expect(host.querySelector('marker[id$="pointEnd"] path')?.getAttribute('d')).toBe('M 2 1 L 7 5 L 2 9');
    expect(host.querySelector('script, foreignObject')).toBeNull();
    expect(document.querySelector('.markdown-mermaid-measure')).toBeNull();
  });

  it('keeps sequence diagrams on the official Mermaid renderer', async () => {
    const svg = await renderMermaid('integration-sequence', 'sequenceDiagram\n用户->>Agent: 请求\nAgent-->>用户: 结果', theme);
    expect(svg).toContain('请求');
    expect(svg).toContain('结果');
    const host = document.createElement('div');
    host.innerHTML = svg!;
    expect(host.querySelector('.ema-mermaid-decision')).toBeNull();
  });

  it('passes rank spacing through the patched adapter into actual ELK positions', async () => {
    const graph = 'flowchart TD\nA[开始] --> B[结束]';
    const compact = await renderMermaid('integration-spacing-compact', graph, theme);
    const spacious = await renderMermaid('integration-spacing-spacious', `---\nconfig:\n  flowchart:\n    rankSpacing: 144\n---\n${graph}`, theme);

    function verticalDistance(svg: string): number {
      const host = document.createElement('div');
      host.innerHTML = svg;
      const positions = Array.from(host.querySelectorAll('g.node'), node => {
        const transform = node.getAttribute('transform')!;
        return Number(transform.match(/translate\([^,]+,\s*([\d.-]+)/)![1]);
      });
      expect(positions).toHaveLength(2);
      return Math.abs(positions[1] - positions[0]);
    }

    expect(verticalDistance(spacious!) - verticalDistance(compact!)).toBeCloseTo(100);
  });
});
