// 测试 Memory 召回上下文消息的新鲜度标注、"N 天前"时间格式与单条正文上限。

import { describe, expect, it } from 'vitest';
import { buildContextMessage } from '../recall/context-builder.js';
import type { RecallBundle } from '../types.js';

const DAY_MS = 86_400_000;

function bundleWithLayer2(body: string, updatedAt: number): RecallBundle {
  return {
    layer2: {
      currentMode: [{
        id: 'item-1',
        kind: 'project',
        title: '发布冻结',
        body,
        importance: 80,
        updatedAt,
        createdAt: updatedAt,
        sessionId: 'session-1',
      }],
      otherModes: [],
    },
  } as unknown as RecallBundle;
}

describe('Memory 召回上下文消息', () => {
  it('召回块带"可能已过时"时效标注', () => {
    const message = buildContextMessage(bundleWithLayer2('移动端发布冻结', Date.now()));

    expect(message?.content).toContain('可能已过时');
    expect(message?.content).toContain('使用前请先验证');
  });

  it('时间戳渲染为"今天/昨天/N 天前"而非 ISO 格式', () => {
    const now = Date.now();
    const today = buildContextMessage(bundleWithLayer2('x', now));
    const yesterday = buildContextMessage(bundleWithLayer2('x', now - DAY_MS));
    const older = buildContextMessage(bundleWithLayer2('x', now - 47 * DAY_MS));

    expect(today?.content).toContain('(今天)');
    expect(yesterday?.content).toContain('(昨天)');
    expect(older?.content).toContain('(47 天前)');
    expect(older?.content).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('单条正文超过上限时截断并保留省略标记', () => {
    const longBody = '长'.repeat(600);
    const message = buildContextMessage(bundleWithLayer2(longBody, Date.now()));

    expect(message?.content).toContain('…');
    // 500 字正文 + 省略号，不应出现完整 600 字
    expect(message?.content).not.toContain('长'.repeat(600));
  });

  it('节点 description 同样受单条上限约束', () => {
    const bundle = {
      layer0: {
        nodes: [{
          id: 'node-1',
          label: '苹果',
          nodeType: 'entity',
          description: '果'.repeat(600),
          importance: 50,
        }],
        edges: [],
      },
    } as unknown as RecallBundle;

    const message = buildContextMessage(bundle);

    expect(message?.content).toContain('…');
    expect(message?.content).not.toContain('果'.repeat(600));
  });
});
