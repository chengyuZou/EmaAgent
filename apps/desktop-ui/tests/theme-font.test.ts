// 测试 Markdown 正文字体预设、自定义字体清理和跨平台回退规则。
import { describe, expect, it } from 'vitest';
import {
  normalizeLocalFontName,
  resolveContentFontStack,
} from '../src/stores/theme-store.js';

describe('Markdown 正文字体', () => {
  it('系统预设通过 CSS token 跟随各平台字体栈', () => {
    expect(resolveContentFontStack('system', '')).toBe('var(--ema-font-content-system)');
  });

  it('自定义字体只接受本地字体名称，不能注入 CSS 声明', () => {
    expect(normalizeLocalFontName("  LXGW WenKai'; position: fixed;  "))
      .toBe('LXGW WenKai position fixed');
    expect(resolveContentFontStack('custom', "My Font'; color:red"))
      .toBe("'My Font colorred', var(--ema-font-content-system)");
  });

  it('空自定义字体自动回退到系统字体', () => {
    expect(resolveContentFontStack('custom', '  ')).toBe('var(--ema-font-content-system)');
  });
});
