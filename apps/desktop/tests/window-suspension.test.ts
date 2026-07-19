// 测试桌面宿主显隐与浏览器页面可见性的统一暂停判定。
import { describe, expect, it } from 'vitest';
import { resolveWindowSuspended } from '../src/hooks/use-window-suspension.js';

describe('resolveWindowSuspended', () => {
  it.each([
    { documentHidden: false, hostVisible: true, expected: false },
    { documentHidden: true, hostVisible: true, expected: true },
    { documentHidden: false, hostVisible: false, expected: true },
    { documentHidden: true, hostVisible: false, expected: true },
  ])('根据两个可见性来源得到 $expected', ({ documentHidden, hostVisible, expected }) => {
    expect(resolveWindowSuspended(documentHidden, hostVisible)).toBe(expected);
  });
});
