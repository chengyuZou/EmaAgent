import { describe, expect, it } from 'vitest';
import { StageEngine } from '../engine.js';

function makeEngine() {
  const engine = new StageEngine({ emotions: ['happy', 'sad'], motions: ['wave'] });
  engine.beginTurn('session');
  return engine;
}

describe('StageEngine ordered text', () => {
  it('保留文字和标签顺序, 没有标签的正文使用 null', () => {
    const engine = makeEngine();
    expect(engine.processChunk('我觉得<emotion>happy</emotion><motion>wave</motion>能解决.', 'session')).toEqual([
      { text: '我觉得', tags: [{ type: 'emotion', emotion: 'happy' }] },
      { text: null, tags: [{ type: 'motion', motion: 'wave' }] },
      { text: '能解决.', tags: null },
    ]);
  });

  it('标签跨分片暂存, 不给前文补标点', () => {
    const engine = makeEngine();
    expect(engine.processChunk('我觉得<emotion>h', 'session')).toEqual([{ text: '我觉得', tags: null }]);
    expect(engine.processChunk('appy</emotion>后面.', 'session')).toEqual([
      { text: null, tags: [{ type: 'emotion', emotion: 'happy' }] },
      { text: '后面.', tags: null },
    ]);
  });

  it('未知标签移除, 重复已知标签保持原顺序', () => {
    const engine = makeEngine();
    expect(engine.processChunk('<emotion>unknown</emotion><motion>wave</motion><motion>wave</motion>', 'session')).toEqual([
      { text: null, tags: [{ type: 'motion', motion: 'wave' }] },
      { text: null, tags: [{ type: 'motion', motion: 'wave' }] },
    ]);
  });

  it('角色词汇替换后不接受旧标签', () => {
    const engine = makeEngine();
    engine.updateVocabulary(['calm'], ['nod']);
    expect(engine.processChunk('<emotion>happy</emotion><motion>nod</motion>', 'session')).toEqual([
      { text: null, tags: [{ type: 'motion', motion: 'nod' }] },
    ]);
  });

  it('普通尖括号通过, 新 Turn 丢弃未闭合标签', () => {
    const engine = makeEngine();
    expect(engine.processChunk('<|analysis|>正文<emot', 'session')).toEqual([{ text: '<|analysis|>正文', tags: null }]);
    engine.beginTurn('session');
    expect(engine.processChunk('ion>后文', 'session')).toEqual([{ text: 'ion>后文', tags: null }]);
    engine.processChunk('<emotion>sad', 'session');
    expect(engine.flush('session')).toBe('<emotion>sad');
  });
});
