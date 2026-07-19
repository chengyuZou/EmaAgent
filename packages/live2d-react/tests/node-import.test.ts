// 测试 Node 环境仅导入 Live2D 包时不会因顶层访问 window 而崩溃。
import { describe, expect, it } from 'vitest';
import * as live2dReact from '../src/index.js';

describe('Node import', () => {
  it('无需浏览器全局对象即可读取包导出', () => {
    expect(live2dReact.Live2DStage).toBeTypeOf('object');
    expect(live2dReact.createLive2DRuntime).toBeTypeOf('function');
  });
});
