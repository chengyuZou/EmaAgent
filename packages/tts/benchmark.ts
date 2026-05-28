/**
 * TTS 文本过滤管道 — 性能基准测试
 *
 * Usage:
 *   cd packages/tts
 *   npx tsx benchmark.ts
 *
 * 测试维度：
 *   1. TextFilterStream — 混合 markdown / 纯文本吞吐
 *   2. filterSentenceForTts — 各种 pattern 密集度下的延迟
 *   3. SentenceSplitter — 中英文混合分句吞吐
 *   4. 端到端管道 — LLM delta → 清洗后句子
 */

import { TextFilterStream, filterSentenceForTts } from './src/streaming/text-filter.js';
import { SentenceSplitter } from './src/streaming/sentence-splitter.js';

// ── 测试数据集 ────────────────────────────────────────────────────────────────

/** 模拟典型 LLM 对话输出：中文为主，偶尔夹杂英文和 markdown */
function generateChatText(paragraphs: number): string {
  const lines: string[] = [];
  const templates = [
    '你好！我是艾玛，很高兴认识你。',
    '今天我们来聊一个有趣的话题吧。',
    '当然可以！让我来帮你分析一下这个问题。',
    '根据我的理解，这个方案有以下**三个优点**：',
    '首先，它的性能非常出色，响应速度很快。',
    '其次，代码结构清晰，可以参考 `src/main.ts` 中的实现。',
    '最后，社区支持活跃，GitHub 上有超过 1000 个 star。',
    '你可以在 https://github.com/example/repo 查看更多信息。',
    '有什么其他问题吗？我随时可以帮助你！',
    '嗯…让我想想，这个问题确实有点复杂。',
    '简单来说，它的原理是这样的：',
    '```python\ndef fibonacci(n):\n    if n <= 1: return n\n    return fibonacci(n-1) + fibonacci(n-2)\n```',
    '上面的代码展示了一个经典的递归实现。',
    '不过要注意，递归的性能不太好，可以考虑用迭代优化。',
    '数学上可以证明，时间复杂度是 $O(2^n)$。',
    '好了，以上就是我的分析，希望能帮到你！',
  ];
  for (let i = 0; i < paragraphs; i++) {
    lines.push(templates[i % templates.length]!);
  }
  return lines.join('\n\n');
}

/** 模拟 agent 模式输出：大量代码块和路径 */
function generateAgentText(codeBlockCount: number): string {
  const lines: string[] = ['好的，我来帮你完成这个任务。\n'];
  for (let i = 0; i < codeBlockCount; i++) {
    lines.push(`先看看第 ${i + 1} 个文件:\n`);
    lines.push('```typescript\n');
    lines.push('import { readFile } from "node:fs/promises";\n');
    lines.push('import path from "node:path";\n');
    lines.push('\n');
    lines.push(`export async function loadConfig(filePath: string): Promise<Config> {\n`);
    lines.push('  const raw = await readFile(filePath, "utf-8");\n');
    lines.push('  return JSON.parse(raw) as Config;\n');
    lines.push('}\n');
    lines.push('```\n');
    lines.push(`配置文件在 \`C:\\\\Users\\\\admin\\\\config${i}.json\` ，我已经读取完毕。\n`);
  }
  lines.push('以上就是全部内容，任务完成！');
  return lines.join('');
}

/** 纯中文对话（无任何 markdown，快速路径最佳场景） */
function generatePureChinese(sentenceCount: number): string[] {
  const sentences: string[] = [];
  const templates = [
    '你好！', '今天天气真好。', '我很喜欢看书。', '这道菜很好吃！',
    '明天见。', '谢谢你帮助我。', '这个问题很简单。', '我们一起走吧。',
    '他说的很有道理。', '我完全同意你的看法。', '时间不早了，该休息了。',
    '你能再说一遍吗？', '这是我最喜欢的电影。', '没想到会在这里遇到你。',
    '祝你生日快乐！', '请稍等一下。', '我已经准备好了。', '真是太棒了！',
  ];
  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(templates[i % templates.length]!);
  }
  return sentences;
}

/** 密集 markdown 句子（测试 filterSentenceForTts 全部路径） */
function generateMarkdownSentences(count: number): string[] {
  const sentences: string[] = [];
  const templates = [
    '请看这个链接 [GitHub](https://github.com/example) 了解更多。',
    '**重要提示**：请勿在生产环境使用此配置！',
    '这是一段*斜体*和**粗体**混合的文字。',
    '使用 `console.log("hello")` 打印输出。',
    '配置路径为 `C:\\Users\\admin\\app\\config.yaml` 。',
    '公式 $E=mc^2$ 是爱因斯坦最著名的方程。',
    '访问 https://example.com/api/v2 获取数据。',
    '~~这个功能已经废弃~~ 请使用新 API。',
    '![架构图](https://img.example.com/arch.png) 展示了系统设计。',
    '| 名称 | 版本 | 状态 |\n|------|------|------|\n| Ema  | v1.0 | 正常 |',
    '# 第一章\n这是第一章的内容。',
    '> 这是一段引用文字。\n> 引用可以多行。',
    '- 第一项\n- 第二项\n- 第三项',
    '1. 第一步\n2. 第二步\n3. 第三步',
    '行内公式 \\(\\sum_{i=1}^{n} x_i\\) 在这里。',
    '<strong>警告</strong>：操作不可逆！',
  ];
  for (let i = 0; i < count; i++) {
    sentences.push(templates[i % templates.length]!);
  }
  return sentences;
}

// ── 计时工具 ──────────────────────────────────────────────────────────────────

function bench(name: string, fn: () => void, iterations: number): void {
  // 预热
  for (let i = 0; i < Math.min(100, iterations / 10); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const avgUs = Math.round((elapsed / iterations) * 1000);

  console.log(`  ${name}`);
  console.log(`    迭代: ${iterations.toLocaleString()}  |  总耗时: ${elapsed.toFixed(1)}ms  |  ${opsPerSec.toLocaleString()} ops/s  |  平均 ${avgUs}μs/op`);
}

function benchThroughput(name: string, fn: () => void, totalBytes: number, minMs = 2000): void {
  // 预热
  fn();

  const start = performance.now();
  let iterations = 0;
  while (performance.now() - start < minMs) {
    fn();
    iterations++;
  }
  const elapsed = performance.now() - start;
  const mbProcessed = (totalBytes * iterations) / (1024 * 1024);
  const mbPerSec = mbProcessed / (elapsed / 1000);

  console.log(`  ${name}`);
  console.log(`    迭代: ${iterations}  |  处理量: ${mbProcessed.toFixed(1)} MB  |  吞吐: ${mbPerSec.toFixed(1)} MB/s  |  ${elapsed.toFixed(0)}ms`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK 1 — TextFilterStream
// ═══════════════════════════════════════════════════════════════════════════════

function benchTextFilterStream(): void {
  console.log('\n═══ 1. TextFilterStream（有状态块级清洗） ═══');

  // 1a. 纯文本直通
  const pureText = generateChatText(200).repeat(5); // ~50KB 纯文本
  {
    const totalBytes = Buffer.byteLength(pureText, 'utf-8');
    benchThroughput('纯文本直通（无代码块）', () => {
      const s = new TextFilterStream('chat');
      s.feed(pureText);
      s.flush();
    }, totalBytes);
  }

  // 1b. 混合内容（含代码块）
  const mixedText = generateChatText(100).repeat(5); // 含代码块
  {
    const totalBytes = Buffer.byteLength(mixedText, 'utf-8');
    benchThroughput('混合内容（含代码块/数学块）', () => {
      const s = new TextFilterStream('chat');
      s.feed(mixedText);
      s.flush();
    }, totalBytes);
  }

  // 1c. agent 模式（大量代码块）
  {
    const agentText = generateAgentText(30);
    const totalBytes = Buffer.byteLength(agentText, 'utf-8');
    benchThroughput('Agent 模式（密集代码块）', () => {
      const s = new TextFilterStream('agent');
      s.feed(agentText);
      s.flush();
    }, totalBytes);
  }

  // 1d. 模拟流式场景（大量小 chunk）
  {
    const text = generateChatText(100);
    const chunks = splitIntoChunks(text, 20); // 每 chunk ~20 字符
    const totalBytes = Buffer.byteLength(text, 'utf-8');
    benchThroughput('流式小 chunk（20 字符/chunk）', () => {
      const s = new TextFilterStream('chat');
      for (const c of chunks) s.feed(c);
      s.flush();
    }, totalBytes);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK 2 — filterSentenceForTts
// ═══════════════════════════════════════════════════════════════════════════════

function benchFilterSentence(): void {
  console.log('\n═══ 2. filterSentenceForTts（无状态行内清洗） ═══');

  // 2a. 快速路径 — 纯中文
  const pureZh = generatePureChinese(500);
  bench('快速路径：纯中文句子（命中快速路径）', () => {
    for (const s of pureZh) filterSentenceForTts(s, { turnMode: 'chat' });
  }, 20);

  // 2b. 一般路径 — 含 markdown
  const mdSentences = generateMarkdownSentences(500);
  bench('一般路径：密集 markdown 句子', () => {
    for (const s of mdSentences) filterSentenceForTts(s, { turnMode: 'chat' });
  }, 20);

  // 2c. Agent 模式
  bench('Agent 模式：密集 markdown 句子', () => {
    for (const s of mdSentences) filterSentenceForTts(s, { turnMode: 'agent' });
  }, 20);

  // 2d. 混合场景（80% 纯中文 + 20% markdown）
  {
    const mix80 = [
      ...generatePureChinese(400),
      ...generateMarkdownSentences(100),
    ];
    // 打乱顺序
    shuffle(mix80);
    bench('混合场景：80% 纯中文 + 20% markdown', () => {
      for (const s of mix80) filterSentenceForTts(s, { turnMode: 'chat' });
    }, 10);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK 3 — SentenceSplitter
// ═══════════════════════════════════════════════════════════════════════════════

function benchSentenceSplitter(): void {
  console.log('\n═══ 3. SentenceSplitter（句子边界检测） ═══');

  const zhText = generatePureChinese(1000).join('');
  {
    const totalBytes = Buffer.byteLength(zhText, 'utf-8');
    benchThroughput('中文分句', () => {
      const s = new SentenceSplitter();
      s.feed(zhText);
      s.flush();
    }, totalBytes);
  }

  const enText = 'Hello! My name is Ema. How are you today? I hope you are doing well. '.repeat(200);
  {
    const totalBytes = Buffer.byteLength(enText, 'utf-8');
    benchThroughput('英文分句', () => {
      const s = new SentenceSplitter();
      s.feed(enText);
      s.flush();
    }, totalBytes);
  }

  // 模拟流式场景
  {
    const text = generateChatText(100);
    const chunks = splitIntoChunks(text, 30);
    const totalBytes = Buffer.byteLength(text, 'utf-8');
    benchThroughput('流式小 chunk 分句（30 字符/chunk）', () => {
      const s = new SentenceSplitter();
      for (const c of chunks) s.feed(c);
      s.flush();
    }, totalBytes);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK 4 — 端到端管道
// ═══════════════════════════════════════════════════════════════════════════════

function benchEndToEnd(): void {
  console.log('\n═══ 4. 端到端管道（TextFilterStream → SentenceSplitter → filterSentenceForTts） ═══');

  const text = generateChatText(80);
  const chunks = splitIntoChunks(text, 15); // 模拟 LLM delta，每 chunk ~15 字符
  const totalBytes = Buffer.byteLength(text, 'utf-8');

  benchThroughput('完整管道：LLM delta → 清洗后句子', () => {
    const filter = new TextFilterStream('chat');
    const splitter = new SentenceSplitter();
    for (const chunk of chunks) {
      const filtered = filter.feed(chunk);
      if (filtered) {
        for (const s of splitter.feed(filtered)) {
          filterSentenceForTts(s.text, { turnMode: 'chat' });
        }
      }
    }
    const remnant = filter.flush();
    const tail = [
      ...(remnant ? splitter.feed(remnant) : []),
      ...splitter.flush(),
    ];
    for (const s of tail) {
      filterSentenceForTts(s.text, { turnMode: 'chat' });
    }
  }, totalBytes);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK 5 — 对比优化前后
// ═══════════════════════════════════════════════════════════════════════════════

function benchComparison(): void {
  console.log('\n═══ 5. 关键优化点 — 独立验证 ═══');

  // 5a. 快速路径命中率
  {
    const pureZh = generatePureChinese(1000);
    let fastPathHits = 0;
    const marker = /[<![\]*_`$#>\-~|:\\/]/; // 快速路径正则
    for (const s of pureZh) {
      if (!marker.test(s)) fastPathHits++;
    }
    console.log(`  快速路径命中率（纯中文）: ${((fastPathHits / pureZh.length) * 100).toFixed(1)}%`);
  }

  // 5b. 批量扫描 vs 逐字符（模拟对比）
  {
    const line = '这是一段很长的没有任何特殊字符的普通中文对话文本用于测试批量扫描性能提升效果。'.repeat(10);
    // 逐字符方式（旧）
    const startOld = performance.now();
    for (let i = 0; i < 50000; i++) {
      let result = '';
      for (let j = 0; j < line.length; j++) {
        result += line[j];
      }
    }
    const oldMs = performance.now() - startOld;

    // 批量方式（新）
    const startNew = performance.now();
    for (let i = 0; i < 50000; i++) {
      const nl = line.indexOf('\n');
      // 模拟：如果没找到 \n，直接 slice 整行
      const _result = nl === -1 ? line : line.slice(0, nl);
    }
    const newMs = performance.now() - startNew;

    const speedup = (oldMs / newMs).toFixed(1);
    console.log(`  批量扫描 vs 逐字符: ${speedup}x 加速（旧 ${oldMs.toFixed(0)}ms → 新 ${newMs.toFixed(0)}ms）`);
  }

  // 5c. 正则合并效果（行前缀 4→1）
  {
    const RE_HEADING    = /^#{1,6}\s+/gm;
    const RE_BLOCKQUOTE = /^>\s*/gm;
    const RE_LIST_BULLET  = /^[-*+]\s+/gm;
    const RE_LIST_ORDERED = /^\d+\.\s+/gm;
    const RE_LINE_PREFIX  = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm;

    const text = '# 标题\n> 引用\n- 列表\n1. 有序\n正文内容。\n'.repeat(2000);

    // 旧方式：4 次 replace
    const startOld = performance.now();
    for (let i = 0; i < 500; i++) {
      let t = text;
      t = t.replace(RE_HEADING, '');
      t = t.replace(RE_BLOCKQUOTE, '');
      t = t.replace(RE_LIST_BULLET, '');
      t = t.replace(RE_LIST_ORDERED, '');
    }
    const oldMs = performance.now() - startOld;

    // 新方式：1 次 replace
    const startNew = performance.now();
    for (let i = 0; i < 500; i++) {
      text.replace(RE_LINE_PREFIX, '');
    }
    const newMs = performance.now() - startNew;

    const speedup = (oldMs / newMs).toFixed(1);
    console.log(`  行前缀合并（4→1 replace）: ${speedup}x 加速（旧 ${oldMs.toFixed(0)}ms → 新 ${newMs.toFixed(0)}ms）`);
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function splitIntoChunks(text: string, avgSize: number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    // 模拟 LLM delta 在词边界附近切割
    const jitter = Math.floor(Math.random() * avgSize * 0.6) - Math.floor(avgSize * 0.3);
    let end = pos + avgSize + jitter;
    if (end >= text.length) end = text.length;
    // 尽量在换行处切割
    const nl = text.lastIndexOf('\n', end);
    if (nl > pos && nl > end - avgSize / 2) end = nl;
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════╗');
console.log('║   TTS 文本过滤管道 — 性能基准测试                ║');
console.log('╚══════════════════════════════════════════════════╝');

benchTextFilterStream();
benchFilterSentence();
benchSentenceSplitter();
benchEndToEnd();
benchComparison();

console.log('\n✅ 基准测试完成');
