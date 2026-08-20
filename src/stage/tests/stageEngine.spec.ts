// 测试 StageEngine 的标签清洗、情绪状态机与动作词汇校验。
import { describe, expect, it } from 'vitest';
import { StageEngine } from '../engine.js';

function makeEngine() {
  return new StageEngine({ emotions: ['happy', 'sad'], motions: ['wave'] });
}

describe('StageEngine', () => {
  it('已知情绪转移状态并发事件；未知情绪只清洗正文', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');
    const first = engine.processChunk('我<emotion>happy</emotion>开心', 't1', 's1');
    expect(first.cleaned).toBe('我开心');
    expect(first.events).toEqual([expect.objectContaining({
      type: 'emotion_changed',
      state: expect.objectContaining({ primary: 'happy' }),
    })]);

    const second = engine.processChunk('<emotion>jealous</emotion>', 't1', 's1');
    expect(second.cleaned).toBe('');
    expect(second.events).toEqual([]);
    expect(engine.current('s1')?.primary).toBe('happy');
  });

  it('已知动作发 stage_cue；模型编造的动作名不发事件只清洗', () => {
    const engine = makeEngine();
    engine.beginTurn('s1');
    const known = engine.processChunk('<motion>wave</motion>你好', 't1', 's1');
    expect(known.events).toEqual([expect.objectContaining({
      type: 'stage_cue',
      cue: expect.objectContaining({ motion: 'wave' }),
    })]);
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
    expect(result.events.map(e => e.type)).toEqual(['stage_cue']);
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
});
