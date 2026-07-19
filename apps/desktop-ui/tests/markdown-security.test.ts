// 测试 Markdown 清洗边界、外部链接保护，以及清洗后的公式和代码高亮。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/markdown/renderer.js';

function render(source: string): string {
  return renderToStaticMarkup(createElement(Markdown, { source }));
}

describe('Markdown 安全渲染', () => {
  it('保留 raw HTML 文本，但移除可覆盖界面的样式、ID 和类名', () => {
    const html = render(
      '<span id="fake-dialog" class="fixed inset-0" style="position:fixed;inset:0">伪造弹窗</span>',
    );

    expect(html).toContain('伪造弹窗');
    expect(html).not.toContain('fake-dialog');
    expect(html).not.toContain('position:fixed');
    expect(html).not.toContain('inset-0');
  });

  it('移除危险协议，并为外部 HTTP 链接补齐安全属性', () => {
    const html = render('[危险](javascript:alert(1)) [官网](https://example.com/docs)');

    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('安全清洗后仍能生成可信的 KaTeX 和代码高亮内容', () => {
    const mathHtml = render('$x^2$');
    const codeHtml = render('```javascript\nconst answer = 42;\n```');

    expect(mathHtml).toContain('class="katex"');
    expect(mathHtml).toContain('katex-mathml');
    expect(codeHtml).toContain('class="hljs language-javascript"');
    expect(codeHtml).toContain('hljs-keyword');
  });
});
