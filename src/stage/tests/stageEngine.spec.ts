// 测试 StageEngine 的标签清洗、跨 delta 扫描与角色词汇校验.
import { describe, expect, it } from 'vitest';
import { StageEngine } from '../engine.js';

function makeEngine() {
  return new StageEngine({ emotions: ['happy', 'sad'], motions: ['wave'] });
}

describe('StageEngine', () => {
  it('每个已知情绪标签都发事件，未知情绪只清洗正文', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');
    const first = engine.processChunk('我<emotion>happy</emotion>开心', 't1', 's1');
    expect(first.cleaned).toBe('我开心');
    expect(first.events).toEqual([
      { type: 'emotion_changed', sessionId: 's1', turnId: 't1', emotion: 'happy' },
    ]);

    const unknown = engine.processChunk('<emotion>jealous</emotion>', 't1', 's1');
    expect(unknown.cleaned).toBe('');
    expect(unknown.events).toEqual([]);

    const repeated = engine.processChunk('<emotion>happy</emotion>', 't1', 's1');
    expect(repeated.events).toEqual([
      { type: 'emotion_changed', sessionId: 's1', turnId: 't1', emotion: 'happy' },
    ]);
  });

  it('已知动作发 motion_changed；模型编造的动作名不发事件只清洗', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');
    const known = engine.processChunk('<motion>wave</motion>你好', 't1', 's1');
    expect(known.events).toEqual([
      { type: 'motion_changed', sessionId: 's1', turnId: 't1', motion: 'wave' },
    ]);
    expect(known.cleaned).toBe('你好');

    const unknown = engine.processChunk('<motion>fly_away</motion>文本', 't1', 's1');
    expect(unknown.events).toEqual([]);
    expect(unknown.cleaned).toBe('文本');
  });

  it('切换角色后词汇整体替换', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');
    engine.updateVocabulary(['calm'], ['nod']);
    const result = engine.processChunk('<emotion>happy</emotion><motion>nod</motion>', 't1', 's1');
    expect(result.events.map(e => e.type)).toEqual(['motion_changed']);
  });

  it('跨 delta 拆开的标签也能识别', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');
    const a = engine.processChunk('文本<emot', 't1', 's1');
    expect(a.cleaned).toBe('文本');
    const b = engine.processChunk('ion>sad</emotion>后续', 't1', 's1');
    expect(b.events.map(e => e.type)).toEqual(['emotion_changed']);
    expect(b.cleaned).toBe('后续');
  });

  it('非角色标签从索引 0 开始时按正文通过且扫描会终止', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');

    const specialTokenPrefix = engine.processChunk('<|', 't1', 's1');
    expect(specialTokenPrefix).toEqual({ cleaned: '<|', events: [] });

    const obsoleteMarkers = engine.processChunk(
      '<|emotion|>happy<|/emotion|>《emotion》',
      't1',
      's1',
    );
    expect(obsoleteMarkers).toEqual({
      cleaned: '<|emotion|>happy<|/emotion|>《emotion》',
      events: [],
    });
  });

  it('无关尖括号不会妨碍后面的合法 motion 标签跨 delta 识别', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');

    const first = engine.processChunk('<分析>正文<mot', 't1', 's1');
    expect(first).toEqual({ cleaned: '<分析>正文', events: [] });

    const second = engine.processChunk('ion>wave</motion>完成', 't1', 's1');
    expect(second).toEqual({
      cleaned: '完成',
      events: [
        { type: 'motion_changed', sessionId: 's1', turnId: 't1', motion: 'wave' },
      ],
    });
  });
});
