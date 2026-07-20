// 测试 Chromatic 亮度与饱和度修饰符的单项、组合和非法语法。
import { describe, expect, it } from 'vitest';
import { parseChromaticModifiers } from '../src/uno-preset-chromatic.js';

describe('parseChromaticModifiers', () => {
  it('parses individual brightness and saturation modifiers', () => {
    expect(parseChromaticModifiers('bg-primary-500*120')).toEqual({
      base: 'bg-primary-500',
      brightness: '120',
      saturation: undefined,
    });
    expect(parseChromaticModifiers('text-primary-500~80')).toEqual({
      base: 'text-primary-500',
      brightness: undefined,
      saturation: '80',
    });
  });

  it('parses both documented and reversed combination order', () => {
    expect(parseChromaticModifiers('bg-primary-500*110~90')).toEqual({
      base: 'bg-primary-500',
      brightness: '110',
      saturation: '90',
    });
    expect(parseChromaticModifiers('bg-primary-500~90*110')).toEqual({
      base: 'bg-primary-500',
      brightness: '110',
      saturation: '90',
    });
  });

  it('rejects incomplete, duplicate and malformed modifiers', () => {
    expect(parseChromaticModifiers('bg-primary-500')).toBeUndefined();
    expect(parseChromaticModifiers('bg-primary-500*')).toBeUndefined();
    expect(parseChromaticModifiers('bg-primary-500*110*90')).toBeUndefined();
    expect(parseChromaticModifiers('bg-primary-500~90oops')).toBeUndefined();
  });
});
