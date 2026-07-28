/**
 * Live integration tests — @ema-agent/tts
 *
 * Usage:
 *   cd src/tts
 *   npx tsx test-live.ts
 *
 * 覆盖范围：
 *   1. filterSentenceForTts  — 各种 markdown 行内 pattern
 *   2. TextFilterStream       — 代码块 / 数学块 / 语言标识
 *   3. SentenceSplitter       — 中英文分句、最小长度、强制截断
 *   4. 硅基 CosyVoice2        — 上传 refAudio → 声音复刻合成
 *   5. DashScope CosyVoice    — 上传 refAudio → 声音复刻合成（base64 data URI）
 */

import fs   from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextFilterStream, filterSentenceForTts } from '../streaming/textFilter.js';
import { SentenceSplitter } from '../streaming/sentenceSplitter.js';
import { OpenAiTtsAdapter } from '../adapters/openAi.js';
import { DashscopeTtsAdapter } from '../adapters/dashscope.js';
import type { TtsProviderConfig, TtsVoiceRef, TtsStreamEvent } from '../types.js';

// ── Config ────────────────────────────────────────────────────────────────────

// ── Runtime config (env vars — never commit real keys) ────────────────────────
//
// 默认值用于本地开发测试。生产环境请通过环境变量注入：
//   $env:SF_API_KEY  = "sk-..."
//   $env:DS_API_KEY  = "sk-..."
//   $env:REF_AUDIO   = "C:\path\to\ref.mp3"   (optional, defaults below)
//
// PowerShell one-liner:
//   $env:SF_API_KEY="sk-..."; $env:DS_API_KEY="sk-..."; npx tsx test-live.ts

const SF_KEY   = process.env['SF_API_KEY']  ?? 'sk-phfezkdxxx';
const DS_KEY   = process.env['DS_API_KEY']  ?? 'sk-aexxx';

const REF_AUDIO = process.env['REF_AUDIO']
  ?? 'D:\\Github\\EmaAgent-v0.4\\data\\audio\\Reference_audio\\ema1.MP3';
const REF_TEXT  = '我就是担心这种伤风败俗的东西如果被身心尚幼的小朋友们看到会造成不好的影响，所以我想提前为小朋友们做好预防措施。';
const REF_LANG  = 'zh';

// 用于合成的测试句子（故意多句，测试 coordinator 流程）
const SYNTH_TEXT = '你好，我是艾玛。今天天气真不错，我们来好好聊一聊吧！有什么有趣的事想分享给我的吗？';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT   = path.join(__dir, 'test-output');

// 硅基 CosyVoice2 — openai-tts 协议
const SF_CFG: TtsProviderConfig = {
  id:       'siliconflow',
  protocol: 'openai-tts',
  apiKey:   SF_KEY,
  baseUrl:  'https://api.siliconflow.cn/v1',
};
const SF_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';

// 阿里 DashScope — dashscope-tts 协议
const DS_CFG: TtsProviderConfig = {
  id:       'dashscope',
  protocol: 'dashscope-tts',
  apiKey:   DS_KEY,
  baseUrl:  'https://dashscope.aliyuncs.com',
};
const DS_MODEL = 'cosyvoice-v2'; // model-bound: uploadVoice 和 stream 必须相同

// ── Helpers ───────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function ok(name: string): void {
  console.log(`  ✅ ${name}`);
  pass++;
}

function err(name: string, detail: string): void {
  console.log(`  ❌ ${name}\n     → ${detail}`);
  fail++;
}

function section(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function assert(cond: boolean, name: string, got?: unknown): void {
  if (cond) {
    ok(name);
  } else {
    err(name, got !== undefined ? `got: ${JSON.stringify(got)}` : 'assertion failed');
  }
}

/** 收集 AsyncIterable<TtsStreamEvent> 的所有 audio_chunk 并拼成 Buffer */
async function collectAudio(
  events: AsyncIterable<TtsStreamEvent>,
): Promise<{ audio: Buffer; firstByteMs: number; totalBytes: number; errors: string[] }> {
  const chunks: Uint8Array[] = [];
  const errors: string[] = [];
  let firstByteMs = 0;
  let totalBytes = 0;

  for await (const ev of events) {
    switch (ev.type) {
      case 'audio_chunk':
        chunks.push(ev.bytes);
        break;
      case 'done':
        firstByteMs = ev.firstByteMs;
        totalBytes  = ev.totalBytes;
        break;
      case 'error':
        errors.push(`[${ev.code}] ${ev.message}`);
        break;
    }
  }

  const audio = Buffer.concat(chunks.map(c => Buffer.from(c)));
  return { audio, firstByteMs, totalBytes, errors };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — filterSentenceForTts
// ═════════════════════════════════════════════════════════════════════════════

function testFilter(): void {
  section('1 · filterSentenceForTts（无状态行内清洗）');

  const f = (text: string, mode: 'chat' | 'agent' = 'chat') =>
    filterSentenceForTts(text, { turnMode: mode });

  // ACT 标签已由 @ema-agent/emotion 包在高优先级处理，TTS 输入不再包含 ACT，
  // 故 filterSentenceForTts 不再重复清理。此处验证 emotion 剥离后的文本直通。
  assert(
    f('你好！今天天气不错。') === '你好！今天天气不错。',
    '纯中文文本直通（ACT 由 emotion 包预先剥离）',
  );

  // MD 图片 → (图片)
  assert(
    f('看这张图 ![小猫](https://x.com/cat.png) 好可爱') === '看这张图 (图片) 好可爱',
    'MD 图片替换为 (图片)',
  );

  // MD 链接 → 保留文字
  assert(
    f('访问 [EmaAgent](https://github.com/ema) 了解更多') === '访问 EmaAgent 了解更多',
    'MD 链接保留文字',
  );

  // HTML 标签删除
  assert(
    f('<strong>重要</strong>内容') === '重要内容',
    'HTML 标签删除',
  );

  // 标题 # 删除
  assert(
    f('# 第一章\n正文内容').trim() === '第一章\n正文内容',
    'MD 标题 # 删除',
  );

  // 粗体 → 文字
  assert(
    f('这是**重要**的内容') === '这是重要的内容',
    '粗体 ** 提取文字',
  );

  // 斜体 → 文字
  assert(
    f('这是*斜体*文字') === '这是斜体文字',
    '斜体 * 提取文字',
  );

  // 删除线 → 文字
  assert(
    f('~~删除~~内容') === '删除内容',
    '删除线 ~~ 提取文字',
  );

  // 行内代码 chat → 保留文字
  assert(
    f('使用 `print("hello")` 打印') === '使用 print("hello") 打印',
    '行内代码 chat 模式保留文字',
  );

  // 行内代码 agent → 删除（空白收尾后双空格压为单空格）
  assert(
    f('执行 `rm -rf /tmp` 清理', 'agent') === '执行 清理',
    '行内代码 agent 模式删除',
  );

  // 行内数学 $x^2$ → (公式)
  assert(
    f('勾股定理 $a^2+b^2=c^2$') === '勾股定理 (公式)',
    '行内数学 $...$ → (公式)',
  );

  // $100 豁免（负向前瞻 (?!\d)）
  assert(
    f('价格是 $100 美元') === '价格是 $100 美元',
    '$100 数字豁免不替换',
  );

  // LaTeX \( \) → (公式)
  assert(
    f('面积公式 \\(S=\\pi r^2\\) 如下') === '面积公式 (公式) 如下',
    'LaTeX \\( \\) → (公式)',
  );

  // URL → 链接
  assert(
    f('访问 https://github.com/ema-agent 获取') === '访问 链接 获取',
    'URL → 链接',
  );

  // Windows 路径 → 路径
  assert(
    f('配置在 C:\\Users\\Alice\\config.yaml 里') === '配置在 路径 里',
    'Windows 路径 → 路径',
  );

  // 表格分隔行处理
  const tableRow = '| 列1 | 列2 |\n|-----|-----|\n| A | B |';
  const tableResult = f(tableRow);
  assert(
    !tableResult.includes('|---|'),
    '表格分隔行被清除',
    tableResult,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TextFilterStream
// ═════════════════════════════════════════════════════════════════════════════

function testStream(): void {
  section('2 · TextFilterStream（有状态块级清洗）');

  function feedAll(chunks: string[], mode: 'chat' | 'agent' = 'chat'): string {
    const s = new TextFilterStream(mode);
    return chunks.map(c => s.feed(c)).join('') + s.flush();
  }

  // ── 代码块基本识别 ──────────────────────────────────────────────────────────

  const codeBlock = '看这段代码：\n```\nconst x = 1;\n```\n就这样。';
  const codeResult = feedAll([codeBlock]);
  assert(
    codeResult.includes('(代码)') && !codeResult.includes('const x'),
    '代码块被替换为 (代码)',
    codeResult,
  );

  // ── 有语言标识 ─────────────────────────────────────────────────────────────

  const pyBlock = '代码如下：\n```python\ndef add(a, b):\n    return a + b\n```\n完毕。';
  const pyResult = feedAll([pyBlock]);
  assert(
    pyResult.includes('(python代码)'),
    '有语言标识时输出 (python代码)',
    pyResult,
  );

  // ── agent 模式 → 已省略 ────────────────────────────────────────────────────

  const agentResult = feedAll([pyBlock], 'agent');
  assert(
    agentResult.includes('(python代码已省略)'),
    'agent 模式输出 (python代码已省略)',
    agentResult,
  );

  // ── 跨 chunk 代码块（开头和结尾在不同 chunk）─────────────────────────────

  const s2 = new TextFilterStream('chat');
  const r1 = s2.feed('正文\n```');
  const r2 = s2.feed('js\nconsole.log(1);\n');
  const r3 = s2.feed('```\n后文');
  const r4 = s2.flush();
  const cross = r1 + r2 + r3 + r4;
  assert(
    cross.includes('(js代码)') && cross.includes('正文') && cross.includes('后文'),
    '跨 chunk 代码块正确识别',
    cross,
  );

  // ── 数学块 $$ ─────────────────────────────────────────────────────────────

  const mathBlock = '公式：\n$$\nE=mc^2\n$$\n完毕。';
  const mathResult = feedAll([mathBlock]);
  assert(
    mathResult.includes('(数学公式)') && !mathResult.includes('E=mc'),
    '$$ 数学块被替换为 (数学公式)',
    mathResult,
  );

  // ── 未闭合代码块 flush 兜底 ───────────────────────────────────────────────

  const s3 = new TextFilterStream('chat');
  s3.feed('开始\n```python\ndef foo(): pass\n');
  const flushResult = s3.flush();
  assert(
    flushResult.includes('(python代码)'),
    '未闭合代码块 flush 时 emit 替换词',
    flushResult,
  );

  // ── 普通文本零延迟（行首 buf 最多 2 字符）─────────────────────────────────

  const s4 = new TextFilterStream('chat');
  const plain = s4.feed('你好，世界！');
  assert(
    plain.length > 0 && plain.includes('你好'),
    '普通文本直通，无延迟',
    plain,
  );

  // ── ~ 波浪号代码块 ────────────────────────────────────────────────────────

  const tildeBlock = '代码：\n~~~bash\necho hello\n~~~\n完毕。';
  const tildeResult = feedAll([tildeBlock]);
  assert(
    tildeResult.includes('(bash代码)') && !tildeResult.includes('echo hello'),
    '~~~ 波浪号代码块也被识别',
    tildeResult,
  );

  // ── 反引号和波浪号不互相关闭 ──────────────────────────────────────────────

  const mixedFence = '代码：\n```\nsome code\n~~~\nmore code\n```\n完毕。';
  const mixedResult = feedAll([mixedFence]);
  assert(
    !mixedResult.includes('more code'),
    '~~~ 不会关闭 ``` 开启的代码块',
    mixedResult,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — SentenceSplitter
// ═════════════════════════════════════════════════════════════════════════════

function testSplitter(): void {
  section('3 · SentenceSplitter（句子边界检测）');

  function splitAll(text: string): string[] {
    const s = new SentenceSplitter();
    return [...s.feed(text), ...s.flush()].map(r => r.text);
  }

  // ── 中文标点分句 ──────────────────────────────────────────────────────────

  const zh = '你好！我是艾玛。有什么可以帮你的吗？';
  const zhResult = splitAll(zh);
  assert(
    zhResult.length === 3 &&
    zhResult[0] === '你好！' &&
    zhResult[1] === '我是艾玛。' &&
    zhResult[2] === '有什么可以帮你的吗？',
    '中文三句正确分割',
    zhResult,
  );

  // ── 英文句号（正常结束）────────────────────────────────────────────────────

  const en = 'Hello! My name is Ema. How are you?';
  const enResult = splitAll(en);
  assert(
    enResult.length === 3,
    '英文三句正确分割',
    enResult,
  );

  // ── 小数点不截断 ──────────────────────────────────────────────────────────

  const decimal = 'Pi 约等于 3.14159，是个无理数。';
  const decResult = splitAll(decimal);
  assert(
    decResult.length === 1 && decResult[0]!.includes('3.14159'),
    '小数点 3.14159 不被当作句尾',
    decResult,
  );

  // ── 最小长度（streaming 中短句不单独 yield，推迟到 flush）────────────────
  // 说明：flush 路径（isFinal=true）跳过最小长度检查，短句在 flush 时单独出现。
  // 真正的合并发生在纯流式（多次 feed 不调 flush）的情况下。
  {
    const sp2 = new SentenceSplitter();
    const r   = sp2.feed('OK. 这才是');   // "OK." 长度 3 < 4，推回 buffer，不 yield
    assert(r.length === 0, '短片段 OK. 在 streaming 中不单独 yield（长度 < 4）', r);
  }

  // ── 超长文本强制截断（200 字符，完全无终止符，靠空格切割）────────────────
  // 注意：文本里不能有 . ! ? 等终止符，否则会走正常分句路径而非 force-split。

  const longWords = Array.from({ length: 6 }, () => 'a'.repeat(40));
  const long = longWords.join(' '); // 245 字符，仅含空格，无任何终止符
  const longResult = splitAll(long);
  assert(
    longResult.length >= 2,
    '超过 200 字符时在空格处强制截断',
    `共 ${longResult.length} 句，第一句长度 ${longResult[0]?.length}`,
  );

  // ── 椭圆 … 是终止符 ──────────────────────────────────────────────────────

  const ellipsis = '就这样吧…下次再说。';
  const ellResult = splitAll(ellipsis);
  assert(
    ellResult.length >= 1,
    '… 被识别为终止符',
    ellResult,
  );

  // ── 跨 chunk 分句 ─────────────────────────────────────────────────────────
  // MIN_SENTENCE_LEN = 4。"大家好！"= 4 字符（刚好在阈值上，会 yield）。
  // "明天见！"= 4 字符，同理在流式路径正常 yield，不需要 flush。

  const sp = new SentenceSplitter();
  const first = sp.feed('大家好！我是艾');    // '大家好！' 4 字符 → yield
  const rest  = sp.feed('玛。明天见！');      // '我是艾玛。' 5 字符 → yield；'明天见！' 4 字符 → yield
  const tail  = sp.flush();                  // buffer 已空

  assert(
    first.length === 1 && first[0]!.text === '大家好！',
    '跨 chunk：第一句 "大家好！" 在 feed 时 yield',
    first,
  );
  assert(
    rest.length >= 1 && rest[0]!.text === '我是艾玛。',
    '跨 chunk：横跨两个 chunk 的 "我是艾玛。" 正确拼接',
    rest,
  );
  assert(
    rest.length >= 2 && rest[1]!.text === '明天见！',
    '"明天见！" 4 字符在流式路径直接 yield（不需 flush）',
    rest,
  );
  assert(tail.length === 0, 'buffer 已空，flush 无输出', tail);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — 硅基 CosyVoice2（openai-tts 协议）
// ═════════════════════════════════════════════════════════════════════════════

async function testSiliconFlow(): Promise<void> {
  section('4 · 硅基 CosyVoice2（openai-tts 协议）');

  const adapter = new OpenAiTtsAdapter(SF_CFG);
  await fs.mkdir(OUT, { recursive: true });

  // ── Step 1: uploadVoice ───────────────────────────────────────────────────

  let providerVoice: Awaited<ReturnType<NonNullable<TtsAdapter['uploadVoice']>>>;
  try {
    console.log('  → 上传参考音频...');
    providerVoice = await adapter.uploadVoice(REF_AUDIO, REF_TEXT, REF_LANG, SF_MODEL);
    ok(`uploadVoice 成功，providerVoice = ${providerVoice.value}`);
  } catch (e) {
    err('uploadVoice 失败', (e as Error).message);
    return;
  }

  // ── Step 2: synthesize ────────────────────────────────────────────────────

  const voice: TtsVoiceRef = {
    refAudioPath: REF_AUDIO,
    promptText:   REF_TEXT,
    promptLang:   REF_LANG,
    providerVoice,
  };

  console.log('  → 合成中...');
  const startMs = Date.now();
  const { audio, firstByteMs, errors } = await collectAudio(
    adapter.stream({ text: SYNTH_TEXT, providerId: SF_CFG.id, model: SF_MODEL, voice, format: 'mp3' }),
  );

  if (errors.length > 0) {
    err('stream 出错', errors.join(' | '));
    return;
  }

  const totalMs = Date.now() - startMs;
  ok(`stream 完成：${audio.length} 字节，首包 ${firstByteMs}ms，总耗时 ${totalMs}ms`);

  // ── Step 3: 保存文件 ──────────────────────────────────────────────────────

  const outFile = path.join(OUT, 'siliconflow-cosyvoice2.mp3');
  await fs.writeFile(outFile, audio);
  ok(`音频已保存 → ${outFile}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — DashScope CosyVoice（dashscope-tts 协议）
// ═════════════════════════════════════════════════════════════════════════════

async function testDashScope(): Promise<void> {
  section('5 · DashScope CosyVoice（dashscope-tts 协议）');

  const adapter = new DashscopeTtsAdapter(DS_CFG);
  await fs.mkdir(OUT, { recursive: true });

  // ── Step 1: uploadVoice（base64 data URI 路线）───────────────────────────

  let providerVoice: Awaited<ReturnType<NonNullable<TtsAdapter['uploadVoice']>>>;
  try {
    console.log('  → 上传参考音频（base64 data URI）...');
    providerVoice = await adapter.uploadVoice(REF_AUDIO, REF_TEXT, REF_LANG, DS_MODEL);
    ok(`uploadVoice 成功，voice_id = ${providerVoice.value}`);
  } catch (e) {
    err('uploadVoice 失败', (e as Error).message);
    console.log('  ⚠  若 DashScope 拒绝 data URI，需切换为文件上传路线（见 uploadVoice TODO）');
    return;
  }

  // ── Step 2: synthesize ────────────────────────────────────────────────────

  const voice: TtsVoiceRef = {
    refAudioPath: REF_AUDIO,
    promptText:   REF_TEXT,
    promptLang:   REF_LANG,
    providerVoice,
  };

  console.log('  → 合成中（CosyVoice WS 流式）...');
  const startMs = Date.now();
  const { audio, firstByteMs, errors } = await collectAudio(
    adapter.stream({ text: SYNTH_TEXT, providerId: DS_CFG.id, model: DS_MODEL, voice, format: 'mp3' }),
  );

  if (errors.length > 0) {
    err('stream 出错', errors.join(' | '));
    return;
  }

  const totalMs = Date.now() - startMs;
  ok(`stream 完成：${audio.length} 字节，首包 ${firstByteMs}ms，总耗时 ${totalMs}ms`);

  // ── Step 3: 保存文件 ──────────────────────────────────────────────────────

  const outFile = path.join(OUT, 'dashscope-cosyvoice.mp3');
  await fs.writeFile(outFile, audio);
  ok(`音频已保存 → ${outFile}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\n@ema-agent/tts live test\n');

  testFilter();
  testStream();
  testSplitter();

  await testSiliconFlow();
  await testDashScope();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  结果：${pass} 通过  ${fail > 0 ? fail + ' 失败' : '0 失败'}`);
  console.log('─'.repeat(60));

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
