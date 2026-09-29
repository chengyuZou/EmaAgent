// 官方 Mermaid/ELK 负责绘图; 这里集中管理主题、串行测量与有限缓存.
import type { LayoutLoaderDefinition, MermaidConfig } from 'mermaid';

export interface MermaidAppearance {
  dark: boolean;
  fontFamily: string;
  text: string;
  secondaryText: string;
  background: string;
  node: string;
  nodeBorder: string;
  line: string;
  cluster: string;
}

type MermaidEngine = (typeof import('mermaid'))['default'];

const svgCache = new Map<string, Promise<string | null>>();
const cacheLimit = 50;
let renderQueue: Promise<void> = Promise.resolve();
let enginePromise: Promise<MermaidEngine> | undefined;
let renderSequence = 0;
let appearanceStamp: string | undefined;
let appearance: MermaidAppearance;

export function readMermaidAppearance(stamp: string): MermaidAppearance {
  if (stamp === appearanceStamp) return appearance;

  const root = document.documentElement;
  const dark = root.dataset.theme !== 'light';
  const probe = document.createElement('span');
  probe.hidden = true;
  document.body.append(probe);
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;

  // Mermaid 的主题计算接受十六进制颜色; 用浏览器转换现有 oklch/color-mix token.
  function color(token: string, fallback: string, backdrop?: string): string {
    probe.style.color = `var(${token}, ${fallback})`;
    context.clearRect(0, 0, 1, 1);
    if (backdrop) {
      context.fillStyle = backdrop;
      context.fillRect(0, 0, 1, 1);
    }
    context.fillStyle = getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return `#${Array.from(pixel.slice(0, 3), value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  try {
    const background = color('--ema-surface-1', dark ? '#1c1c20' : '#ffffff');
    appearance = {
      dark,
      fontFamily: getComputedStyle(root).getPropertyValue('--ema-font-content').trim() || 'sans-serif',
      text: color('--ema-text-primary', dark ? '#eeeeee' : '#222222'),
      secondaryText: color('--ema-text-secondary', dark ? '#bbbbbb' : '#555555'),
      background,
      node: color('--ema-primary-muted', dark ? '#183b45' : '#e5f3ff', background),
      nodeBorder: color('--ema-primary', '#38a6c2'),
      line: color('--ema-text-tertiary', dark ? '#888888' : '#777777'),
      cluster: color('--ema-surface-2', dark ? '#242428' : '#f0eef5', background),
    };
    appearanceStamp = stamp;
    return appearance;
  } finally {
    probe.remove();
  }
}

function styledElk(layout: LayoutLoaderDefinition): LayoutLoaderDefinition {
  return {
    ...layout,
    async loader() {
      const elk = await layout.loader();
      return {
        async render(data, svg, helpers, options) {
          const flowchart = ['flowchart', 'flowchart-v2', 'flowchart-elk'].includes(data.type);
          if (flowchart) {
            for (const node of data.nodes) {
              if (node.isGroup) continue;
              if (['diamond', 'diam', 'decision', 'question'].includes(node.shape ?? '')) {
                node.shape = 'rect';
                node.cssClasses = `${node.cssClasses ?? ''} ema-mermaid-decision`;
              }
              if (['rect', 'squareRect', 'proc', 'process', 'rectangle', 'rounded', 'roundedRect', 'event'].includes(node.shape ?? '')) {
                node.shape = 'rect';
                node.padding = 16;
                node.labelPaddingX = 24;
                node.height = Math.max(node.height ?? 0, 52);
              }
            }
          }

          await elk.render(data, svg, helpers, options);
          if (!flowchart) return;

          // 只调整普通箭头的外观, 不改变圆头、交叉头或官方 ELK 的连线路径.
          for (const [end, path] of [[true, 'M 2 1 L 7 5 L 2 9'], [false, 'M 8 1 L 3 5 L 8 9']] as const) {
            const suffix = end ? 'pointEnd' : 'pointStart';
            const markers = svg.selectAll<SVGMarkerElement, unknown>(`marker[id$="${suffix}"], marker[id*="-${suffix}_"]`);
            markers.attr('viewBox', '0 0 10 10').attr('refX', end ? 7 : 3).attr('refY', 5)
              .attr('markerWidth', 9).attr('markerHeight', 9);
            markers.select('path').attr('d', path).attr('fill', 'none').attr('stroke-width', 1.5)
              .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
          }
        },
      };
    },
  };
}

function loadEngine(): Promise<MermaidEngine> {
  enginePromise ??= Promise.all([import('mermaid'), import('@mermaid-js/layout-elk')])
    .then(([{ default: mermaid }, { default: layouts }]) => {
      mermaid.registerLayoutLoaders(layouts.map(layout => layout.name === 'elk' ? styledElk(layout) : layout));
      return mermaid;
    });
  return enginePromise;
}

function diagramConfig(theme: MermaidAppearance): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    layout: 'elk',
    theme: 'base',
    darkMode: theme.dark,
    fontFamily: theme.fontFamily,
    // 文件与模型不能用图内指令改掉安全边界、布局或应用主题.
    secure: [
      'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
      'suppressErrorRendering', 'htmlLabels', 'dompurifyConfig', 'themeCSS',
      'theme', 'themeVariables', 'darkMode', 'fontFamily', 'layout',
    ],
    themeVariables: {
      darkMode: theme.dark,
      fontFamily: theme.fontFamily,
      fontSize: '14px',
      background: theme.background,
      primaryColor: theme.node,
      primaryTextColor: theme.text,
      primaryBorderColor: theme.nodeBorder,
      secondaryColor: theme.cluster,
      secondaryTextColor: theme.text,
      secondaryBorderColor: theme.line,
      tertiaryColor: theme.background,
      tertiaryTextColor: theme.text,
      tertiaryBorderColor: theme.line,
      textColor: theme.text,
      titleColor: theme.text,
      lineColor: theme.line,
      edgeLabelBackground: theme.background,
      clusterBkg: theme.cluster,
      clusterBorder: theme.line,
      actorBkg: theme.node,
      actorTextColor: theme.text,
      actorBorder: theme.nodeBorder,
      signalColor: theme.line,
      signalTextColor: theme.text,
      labelTextColor: theme.text,
      noteBkgColor: theme.cluster,
      noteTextColor: theme.text,
      noteBorderColor: theme.line,
    },
    flowchart: { useMaxWidth: false, nodeSpacing: 32, rankSpacing: 44, padding: 16, diagramPadding: 16 },
    sequence: { useMaxWidth: false },
    state: { useMaxWidth: false },
    class: { useMaxWidth: false },
    er: { useMaxWidth: false },
    themeCSS: `
      .node text, .node .label { fill: ${theme.text}; font-size: 14px; font-weight: 600; }
      .node rect { rx: 12px; ry: 12px; }
      .node.ema-mermaid-decision .label-container {
        fill: ${theme.background}; stroke: ${theme.nodeBorder}; stroke-dasharray: 3 3;
      }
      .edgeLabel text { fill: ${theme.secondaryText}; font-size: 12px; font-weight: 500; }
      .edgeLabel .label rect { rx: 8px; ry: 8px; opacity: 1; }
      .flowchart-link { stroke-linecap: round; stroke-linejoin: round; }
      marker path { stroke: ${theme.line}; }
    `,
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => {
    const frame = requestAnimationFrame(() => {
      clearTimeout(timer);
      setTimeout(resolve, 0);
    });
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      resolve();
    }, 50);
  });
}

export function renderMermaid(id: string, source: string, theme: MermaidAppearance): Promise<string | null> {
  // 同一个图块的源码与实际主题没变, 直接复用正在执行或已完成的任务, 包括语法失败结果.
  const key = JSON.stringify([id, source, theme]);
  const cached = svgCache.get(key);
  if (cached) return cached;

  const task = renderQueue.then(async () => {
    const container = document.createElement('div');
    container.className = 'markdown-mermaid-measure';
    container.inert = true;
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    try {
      const mermaid = await loadEngine();
      await document.fonts?.ready;
      await yieldToBrowser();
      // initialize 会修改官方库的全局配置, 必须与 render 一起串行执行.
      mermaid.initialize(diagramConfig(theme));
      const rendered = await mermaid.render(`${id}-${++renderSequence}`, source, container);
      return rendered.svg;
    } catch {
      return null;
    } finally {
      container.remove();
    }
  });
  renderQueue = task.then(() => undefined, () => undefined);
  svgCache.set(key, task);
  if (svgCache.size > cacheLimit) svgCache.delete(svgCache.keys().next().value!);
  return task;
}
