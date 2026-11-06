import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { checkAvailableMemory } from '../checkAvailableMemory.js';

afterEach(() => vi.restoreAllMocks());

it('直接返回可用字节数, 不解释内存是否充足', () => {
  const available = vi.spyOn(process, 'availableMemory').mockReturnValue(1024);
  expect(checkAvailableMemory()).toBe(1024);
  available.mockReturnValue(0);
  expect(checkAvailableMemory()).toBe(0);
});

it.each([NaN, Infinity, -1])('非法系统读数 %s 不当作通过或低内存', value => {
  vi.spyOn(process, 'availableMemory').mockReturnValue(value);
  expect(() => checkAvailableMemory()).toThrow('finite, non-negative byte count');
});

it('系统读取失败不编造内存数字', () => {
  vi.spyOn(process, 'availableMemory').mockImplementation(() => { throw new Error('read failed'); });
  expect(() => checkAvailableMemory()).toThrow('read failed');
});
