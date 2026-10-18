import { createRequire } from 'node:module';

interface JiebaLike {
  cut(text: string, hmm: boolean): string[];
}

const require = createRequire(import.meta.url);
let _jieba: JiebaLike | null | undefined;

function getJieba(): JiebaLike | null {
  if (_jieba !== undefined) return _jieba;
  // 延迟 require 使缺少平台二进制时可以使用后备分词, 不阻断数据库启动.
  try {
    const { Jieba } = require('@node-rs/jieba') as {
      Jieba: { withDict(dictionary: Uint8Array): JiebaLike };
    };
    const { dict } = require('@node-rs/jieba/dict.js') as { dict: Uint8Array };
    _jieba = Jieba.withDict(dict);
  } catch (err) {
    console.warn('[storage] @node-rs/jieba unavailable, FTS falls back to raw text:',
      err instanceof Error ? err.message : err);
    _jieba = null;
  }
  return _jieba;
}

/**
 * 将文本分词为空格连接的 token 字符串,供 FTS 索引/查询.
 * jieba 不可用时使用 portableSegment, 为汉字生成单字和双字词, 为其他字母和数字保留连续段.
 */
export function segmentForFts(text: string): string {
  if (!text.trim()) return '';
  const j = getJieba();
  if (!j) return portableSegment(text);
  return j.cut(text, true).filter(t => t.trim()).join(' ');
}

/** 将用户查询转换为安全的 FTS5 OR phrase,避免标点被解释成查询操作符. */
export function buildFtsQuery(text: string): string | null {
  const terms = segmentForFts(text)
    .split(/\s+/)
    .map(token => token.replace(/"/g, '').trim())
    .filter(Boolean);
  return terms.length > 0 ? terms.map(term => `"${term}"`).join(' OR ') : null;
}

/**
 * 无 native 依赖的跨平台后备分词器.
 * 汉字连续段生成单字和双字 token,拉丁/数字连续段保留为词;因此中文短词
 * 仍能召回,不会退化成"必须整句完全一致"才能命中.
 */
function portableSegment(text: string): string {
  const tokens: string[] = [];
  for (const match of text.matchAll(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu)) {
    const value = match[0];
    if (/^\p{Script=Han}+$/u.test(value)) {
      const characters = [...value];
      tokens.push(...characters);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else {
      tokens.push(value);
    }
  }
  return tokens.join(' ');
}
