// 记录 Live2D 包纯 Node 导入仍受上游 cubism4 顶层 window 访问阻塞的回归测试。
import { describe, it } from 'vitest';

describe('Node import', () => {
  it.todo('通过 Node/SSR 专用导出边界后，无需浏览器全局对象即可读取包导出');
});
