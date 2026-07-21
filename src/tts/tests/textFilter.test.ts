// 测试 TTS 文本过滤状态机、跨 Chunk 边界和行内 Markdown 清洗。
import { describe, it, expect } from 'vitest';
import { TextFilterStream, filterSentenceForTts } from '../streaming/textFilter.js';

// 辅助:把一段文本按 chunk 列表喂进去,返回拼接结果 + flush 尾部。
function runChunks(chunks: string[]): { streamed: string; flushed: string } {
  const f = new TextFilterStream();
  let streamed = '';
  for (const c of chunks) streamed += f.feed(c);
  const flushed = f.flush();
  return { streamed, flushed };
}

// 辅助:一次性喂完整文本(不分块)。
function runOnce(text: string): string {
  const { streamed, flushed } = runChunks([text]);
  return streamed + flushed;
}

// ── normal 状态:普通文本原样通过 ──────────────────────────────────────────────

describe('TextFilterStream normal 状态', () => {
  it('纯文本原样输出', () => {
    expect(runOnce('你好,今天天气不错。')).toBe('你好,今天天气不错。');
  });

  it('多行纯文本保留换行', () => {
    expect(runOnce('第一行\n第二行\n第三行')).toBe('第一行\n第二行\n第三行');
  });

  it('空文本输出空', () => {
    expect(runOnce('')).toBe('');
  });

  it('行内反引号(不足 3 个)不当 fence,原样保留', () => {
    // 单个 ` 在行内不触发 fence(需要行首 3+)
    expect(runOnce('这是 `inline` 代码')).toBe('这是 `inline` 代码');
  });
});

// ── fenced_code:``` 代码块 ────────────────────────────────────────────────────

describe('TextFilterStream 代码块(```)', () => {
  it('完整代码块:内容丢弃,关闭时吐(代码)替换词', () => {
    // 注意:closer 行整行被吞(含其 \n),所以替换词后直接接"后面",无 \n
    const out = runOnce('前面\n```\ncode\n```\n后面');
    expect(out).toBe('前面\n (代码) 后面');
  });

  it('代码块带语言标识:替换词含语言(python代码)', () => {
    const out = runOnce('```python\nprint(1)\n```');
    expect(out).toBe(' (python代码) ');
  });

  it('代码块无语言标识:替换词为(代码)', () => {
    const out = runOnce('```\ncode\n```');
    expect(out).toBe(' (代码) ');
  });

  it('~~~ 也能开代码块(同 ```,不同类字符)', () => {
    const out = runOnce('~~~\ncode\n~~~');
    expect(out).toBe(' (代码) ');
  });

  it('代码块内容含行首 ```:行首的会关块再开新块', () => {
    // 第二行 ``` 在行首,关了第一个块;第三行 ``` 又开个块,flush 兜底 -> 两个替换词
    const out = runOnce('```\n```\n```');
    expect(out).toBe(' (代码)  (代码) ');
  });

  it('多个连续代码块:替换词间是空格(closer 行 \n 被吞)', () => {
    const out = runOnce('```\na\n```\n```\nb\n```');
    expect(out).toBe(' (代码)  (代码) ');
  });
});

// ── math_block:$$ 数学块 ──────────────────────────────────────────────────────

describe('TextFilterStream 数学块($$)', () => {
  it('完整数学块:内容丢弃,关闭时吐(数学公式)', () => {
    // closer 行整行被吞(含 \n),替换词后直接接"后面"
    const out = runOnce('前面\n$$\na^2 + b^2 = c^2\n$$\n后面');
    expect(out).toBe('前面\n (数学公式) 后面');
  });

  it('数学块关闭符是 2 个$(不是 3+)', () => {
    // $$ 开,$$ 关;$$$ 不算合法开(第 3 个 $ 会当普通文本)
    const out = runOnce('$$\nx\n$$');
    expect(out).toBe(' (数学公式) ');
  });
});

// ── 跨 chunk 状态保留(流式核心)──────────────────────────────────────────────

describe('TextFilterStream 跨 chunk 状态保留', () => {
  it('fence 开头被拆到两个 chunk:``` 在 chunk1,python 在 chunk2', () => {
    // chunk1 只给了 ```,还没够 3 个(其实 3 个够转 in_opener),测试 opener 行跨 chunk
    const out = runChunks(['```py', 'thon\nprint(1)\n```']).streamed
             + runChunks(['```py', 'thon\nprint(1)\n```']).flushed;
    // langTag 应跨 chunk 拼成 "python"
    expect(out).toBe(' (python代码) ');
  });

  it('代码块内容跨多个 chunk:内容全部丢弃', () => {
    const chunks = ['```\n', 'line1\n', 'line2\n', 'line3\n', '```'];
    const { streamed, flushed } = runChunks(chunks);
    expect(streamed + flushed).toBe(' (代码) ');
  });

  it('换行符恰好在 chunk 边界:atLineStart 跨 chunk 正确', () => {
    // \n 在 chunk1 末尾,chunk2 开头应被当行首
    const out = runChunks(['text\n', '```\ncode\n```']).streamed
             + runChunks(['text\n', '```\ncode\n```']).flushed;
    expect(out).toBe('text\n (代码) ');
  });

  it('closer 跨 chunk:``` 拆成 `` + `', () => {
    const { streamed, flushed } = runChunks(['```\ncode\n``', '`']);
    expect(streamed + flushed).toBe(' (代码) ');
  });

  it('langTag 跨 chunk:opener 行分多次到', () => {
    const { streamed, flushed } = runChunks(['```', 'java', 'script\nx\n```']);
    expect(streamed + flushed).toBe(' (javascript代码) ');
  });
});

// ── flush 兜底:未闭合块 ──────────────────────────────────────────────────────

describe('TextFilterStream flush 兜底', () => {
  it('未闭合代码块:flush 吐替换词', () => {
    const { streamed, flushed } = runChunks(['```\ncode without end']);
    expect(streamed).toBe('');
    expect(flushed).toBe(' (代码) ');
  });

  it('未闭合数学块:flush 也吐(代码)(flush 走 codeReplacement,不分 math/code)', () => {
    // 源码行为:flush 对 fenced_code/math_block/in_opener 都调 codeReplacement(),
    // 只有正常关闭的 math 才吐 (数学公式);flush 兜底的 math 吐 (代码)。
    const { streamed, flushed } = runChunks(['$$\nx = 1']);
    expect(streamed).toBe('');
    expect(flushed).toBe(' (代码) ');
  });

  it('opener 行未结束就 flush:按未闭合块处理', () => {
    // in_opener 状态(opener 行没收到 \n)flush,也算进了块
    const { streamed, flushed } = runChunks(['```python']);
    expect(streamed).toBe('');
    expect(flushed).toBe(' (python代码) ');
  });

  it('flush 后状态重置:可继续用(空 flush)', () => {
    const f = new TextFilterStream();
    f.feed('```\ncode\n```');
    f.flush();
    // flush 后再 feed 普通文本应原样输出
    expect(f.feed('正常文本')).toBe('正常文本');
  });

  it('flush 时残留的行首缓冲字符当普通文本吐出', () => {
    // 收到 2 个 `(lineStartBuf='``'),还差 1 个,flush 时这 2 个 ` 当普通文本
    const { streamed, flushed } = runChunks(['``']);
    expect(streamed).toBe('');
    expect(flushed).toBe('``');
  });
});

// ── 关闭启发式:数量不精确匹配 ─────────────────────────────────────────────────

describe('TextFilterStream 关闭符启发式', () => {
  it('代码块 closer 数量多于 3 也能关(4 个 `)', () => {
    const out = runOnce('```\ncode\n````');
    expect(out).toBe(' (代码) ');
  });

  it('代码块 closer 数量少于 3 不能关(2 个 `)', () => {
    // 2 个 ` 不够,块继续;flush 兜底吐替换词
    const { streamed, flushed } = runChunks(['```\ncode\n``']);
    // `` 在行首只够 2 个,不够 3,块没关 -> flush 兜底
    expect(streamed + flushed).toBe(' (代码) ');
  });

  it('` 开的块不能用 ~ 关(不同类字符)', () => {
    // ``` 开,~~~ 关不掉;块未闭合 -> flush 兜底
    const { streamed, flushed } = runChunks(['```\ncode\n~~~']);
    expect(streamed + flushed).toBe(' (代码) ');
  });
});

// ── filterSentenceForTts:行内清洗(无状态)──────────────────────────────────

describe('filterSentenceForTts 行内清洗', () => {
  it('纯文本快速路径:无特征字符直接返回', () => {
    expect(filterSentenceForTts('今天天气真好')).toBe('今天天气真好');
  });

  it('粗体 **text** -> text', () => {
    expect(filterSentenceForTts('这是 **重点** 内容')).toBe('这是 重点 内容');
  });

  it('斜体 *text* -> text', () => {
    expect(filterSentenceForTts('这是 *斜体* 内容')).toBe('这是 斜体 内容');
  });

  it('删除线 ~~text~~ -> text', () => {
    expect(filterSentenceForTts('~~旧~~新')).toBe('旧新');
  });

  it('行内代码 `code` -> code', () => {
    expect(filterSentenceForTts('用 `npm install` 安装')).toBe('用 npm install 安装');
  });

  it('图片 ![alt](url) -> (图片)', () => {
    expect(filterSentenceForTts('看这张 ![示意图](http://x/y.png) 图')).toBe('看这张 (图片) 图');
  });

  it('链接 [text](url) -> text', () => {
    expect(filterSentenceForTts('参见 [文档](http://x) 了解')).toBe('参见 文档 了解');
  });

  it('网址 -> 链接', () => {
    expect(filterSentenceForTts('访问 https://example.com 看看')).toBe('访问 链接 看看');
  });

  it('Windows 路径 -> 路径', () => {
    expect(filterSentenceForTts('文件在 C:\\Users\\test\\file.txt')).toBe('文件在 路径');
  });

  it('行内数学 $x$ -> (公式)', () => {
    expect(filterSentenceForTts('计算 $a+b$ 的值')).toBe('计算 (公式) 的值');
  });

  it('标题前缀 # -> 去掉(# 是特征字符,触发 replace 链)', () => {
    expect(filterSentenceForTts('## 标题')).toBe('标题');
  });

  it('列表前缀 - / * -> 去掉(含特征字符 - 或 *)', () => {
    expect(filterSentenceForTts('- 列表项')).toBe('列表项');
    expect(filterSentenceForTts('* 列表项')).toBe('列表项');
  });

  it('有序列表 1. 前缀:纯数字句不含特征字符走快速路径,不剥', () => {
    // "1. 第一项" 不含 [<![\]*_`$#>\-~|:\\/] 任何字符,走快速路径直接 trim 返回,
    // 所以 1. 前缀不剥。这是 filterSentenceForTts 的已知行为(快速路径优先)。
    expect(filterSentenceForTts('1. 第一项')).toBe('1. 第一项');
  });

  it('HTML 标签 -> 去掉', () => {
    expect(filterSentenceForTts('<b>粗</b>文本')).toBe('粗文本');
  });

  it('多空格:纯空格句不含特征字符,走快速路径不合并', () => {
    // "a    b     c" 不含特征字符,快速路径直接 trim 返回,空格不合并。
    // 含特征字符的文本才进 replace 链触发 [ \t]+ -> ' ' 合并。
    expect(filterSentenceForTts('a    b     c')).toBe('a    b     c');
  });

  it('多空格合并:含特征字符时触发 replace 链', () => {
    // 含 * 触发 replace 链,末尾 [ \t]+ -> ' ' 把多空格合并
    expect(filterSentenceForTts('a    *b*     c')).toBe('a b c');
  });

  it('trim 首尾空白', () => {
    expect(filterSentenceForTts('  中间  ')).toBe('中间');
  });
});
