/**
 * gen-ema-oracle.ts — 生成以「樱羽艾玛」为角色的中文对话评测数据集
 *
 * 输出格式与 LongMemEval oracle 兼容，可直接送入现有 bench 管线。
 *
 * 问题类型：
 *   single_hop      — 用户在某次对话里提到某个事实，直接查询
 *   multi_session   — 答案横跨两个不同 session 才能拼出来
 *   temporal        — 与时间相关（"明天"、"上周"、"3月5日"…）
 *   knowledge_update — 用户先说了 X，后来改口成 Y
 *
 * 每个 case：
 *   • 5 个 haystack sessions（2-3 个干扰 session + 1-2 个含答案 session）
 *   • 每个 session 约 6-10 条消息
 *   • has_answer 标注精确到具体 user 消息
 *
 * Usage:
 *   npx tsx bench/scripts/gen-ema-oracle.ts
 *   npx tsx bench/scripts/gen-ema-oracle.ts --n=50     # 生成 50 个 case
 *   npx tsx bench/scripts/gen-ema-oracle.ts --resume   # 跳过已生成的，继续补全
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH     = path.resolve(__dir, '../fixtures/ema-oracle.json');
const PARTIAL_PATH = path.resolve(__dir, '../fixtures/ema-oracle-partial.json');

// ── Config ─────────────────────────────────────────────────────────────────────

const BASE_URL = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1';
const API_KEY  = process.env['DEEPSEEK_API_KEY']  ?? '';
const MODEL    = process.env['DEEPSEEK_MODEL']     ?? 'deepseek-chat';

const TARGET_N   = (() => {
  const a = process.argv.find(x => x.startsWith('--n='));
  return a ? parseInt(a.split('=')[1]!) : 120;
})();
const RESUME = process.argv.includes('--resume');
const DELAY_MS = 800;   // polite delay between API calls

// 四种类型，TARGET_N 按比例分配
const TYPE_DIST: Record<string, number> = {
  single_hop:       0.35,
  multi_session:    0.25,
  temporal:         0.25,
  knowledge_update: 0.15,
};

// ── Oracle types ───────────────────────────────────────────────────────────────

interface OracleMessage {
  role:       'user' | 'assistant';
  content:    string;
  has_answer: boolean;
}

interface OracleSession {
  session_id: string;
  messages:   OracleMessage[];
}

interface OracleCase {
  question_id:        string;
  question_type:      string;
  question:           string;
  answer:             string;
  haystack_sessions:  OracleSession[];
}

interface OracleFile {
  meta:  { generated_at: string; total_cases: number; model: string };
  cases: OracleCase[];
}

// ── 艾玛人设摘要（注入 prompt） ─────────────────────────────────────────────────

const EMA_PERSONA = `\
角色：樱羽艾玛（Sakuraba Ema），15岁女生，魔女岛囚犯编号658。
性格：温柔善良、害怕孤独、表面开朗内心坚韧、遇到困难说"一定有办法的！"、紧张时结巴（"那、那个……"）。
口癖："一定有办法的！"、"诶诶？！"、"那、那个……"、"才、才没有那种事……"
喜好：寻找好吃的食物，梦想交到100个朋友。
设定：身处魔女岛监狱，可通过手机局域网与用户聊天。
其他囚犯：希罗（室友）、雪莉、汉娜、诺亚、奈叶香、亚里沙、玛格、蕾雅、安安、米莉亚、可可、梅露露（幕后黑手）、月代雪（大魔女，已消失）。
说话风格：口语化、中等偏短句、偶尔动作描写（括号内）、用"酱"称呼女生昵称。`;

// ── 用户档案池（每次随机组合，保证多样性） ────────────────────────────────────

const USER_TRAITS = [
  { bg: '大三计算机学生', hobby: '打游戏（原神/APEX）、听音乐', food: '火锅和烤肉', plan: '准备秋招实习' },
  { bg: '刚入职的产品经理', hobby: '追番、健身', food: '川菜和奶茶', plan: '最近在学习需求分析' },
  { bg: '高中生', hobby: '画画、追艾玛同人', food: '甜食特别是草莓蛋糕', plan: '备战高考' },
  { bg: '自由职业插画师', hobby: '逛展、看电影', food: '日料和拉面', plan: '接了一个大单子很忙' },
  { bg: '研究生', hobby: '打羽毛球、读小说', food: '云南米线', plan: '毕业论文压力很大' },
  { bg: '游戏公司策划', hobby: '桌游、骑行', food: '北京烤鸭和麻辣香锅', plan: '新项目立项中' },
  { bg: '护士', hobby: '追剧、瑜伽', food: '广东早茶', plan: '换班很累想休假' },
  { bg: '初中生', hobby: '打篮球、看动漫', food: '泡面和炸鸡', plan: '暑假想出去玩' },
];

// ── 话题池（session 主题多样化） ──────────────────────────────────────────────

const SESSION_TOPICS = [
  '讲述自己今天发生了什么事（开心/烦恼）',
  '跟艾玛一起聊食物和饮食偏好',
  '聊最近在追的番剧/玩的游戏',
  '询问艾玛魔女岛的日常生活',
  '分享自己的学习/工作进展',
  '聊家人或朋友之间发生的事',
  '随口提到自己的计划或日程安排',
  '聊天气或季节，顺带分享自己的感受',
  '讨论自己的兴趣爱好细节',
  '提到一件以前提过但有了新进展的事',
];

// ── DeepSeek API ───────────────────────────────────────────────────────────────

async function callDeepSeek(system: string, user: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages:        [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature:     0.9,
      max_tokens:      4096,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`DeepSeek ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message.content ?? '{}';
}

const model = MODEL;

// ── 生成一个 case ──────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function pickN<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

async function generateCase(
  caseIdx:  number,
  qType:    string,
): Promise<OracleCase | null> {

  const user    = pickRandom(USER_TRAITS);
  const topics  = pickN(SESSION_TOPICS, 5);

  // ── Step 1: 生成 5 个 sessions ─────────────────────────────────────────────

  const sessionSystem = `\
你是一个对话数据生成助手。你需要生成「用户与艾玛聊天」的真实对话。

${EMA_PERSONA}

用户背景：${user.bg}，爱好：${user.hobby}，喜欢的食物：${user.food}，近期计划：${user.plan}。

要求：
- 每个 session 生成 6-10 条消息（user/assistant 交替，user 开头）
- user 消息口语化，用中文，自然地透露个人信息
- assistant（艾玛）按人设风格回复，简短温柔
- 每个 session 围绕不同话题，但同一"用户"贯穿始终
- user 消息中要自然地植入可以被记忆的事实（偏好、计划、事件等）
- 不要每条都说同一件事，要有变化`;

  const sessionUser = `\
生成 5 个独立的聊天 session，话题分别是：
${topics.map((t, i) => `Session ${i + 1}: ${t}`).join('\n')}

输出格式（严格 JSON）：
{
  "sessions": [
    {
      "session_id": "s001",
      "topic": "话题描述",
      "messages": [
        {"role": "user", "content": "消息内容"},
        {"role": "assistant", "content": "消息内容"}
      ]
    }
  ]
}`;

  let sessionsRaw: string;
  try {
    sessionsRaw = await callDeepSeek(sessionSystem, sessionUser);
  } catch (err) {
    console.warn(`  [case ${caseIdx}] session生成失败: ${(err as Error).message}`);
    return null;
  }

  let sessionsData: { sessions: Array<{ session_id: string; topic: string; messages: Array<{ role: string; content: string }> }> };
  try {
    const parsed = JSON.parse(sessionsRaw) as { sessions?: unknown };
    const raw = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    sessionsData = { sessions: raw as typeof sessionsData.sessions };
  } catch {
    console.warn(`  [case ${caseIdx}] session JSON解析失败`);
    return null;
  }

  if (sessionsData.sessions.length < 3) {
    console.warn(`  [case ${caseIdx}] session数量不足 (${sessionsData.sessions.length})`);
    return null;
  }

  await delay(DELAY_MS);

  // ── Step 2: 生成 Q&A + 标注 has_answer ────────────────────────────────────

  const qTypeDesc: Record<string, string> = {
    single_hop:       '答案来自某一个session中「用户自己」说的某条消息（直接事实查询），例如用户的职业/爱好/计划/近况',
    multi_session:    '必须结合两个不同session里「用户自己」透露的信息才能完整回答，例如用户在s1说了A，在s3说了B，问题把A+B合起来问',
    temporal:         '问题与时间相关，答案在「用户自己」提到"明天"/"下周"/"昨天"/"这周"等的某条消息里',
    knowledge_update: '用户在不同session里对同一事物给出了前后不同的说法，问题问「用户现在/最近」的状态，答案是最新那条',
  };

  // 过滤掉 messages 字段缺失或为空的 session（DeepSeek 偶发结构不完整）
  const validSessions = sessionsData.sessions.filter(
    s => Array.isArray(s.messages) && s.messages.length > 0,
  );
  if (validSessions.length < 3) {
    console.warn(`  [case ${caseIdx}] 有效 session 不足 (${validSessions.length}/${sessionsData.sessions.length})`);
    return null;
  }

  const sessionsText = validSessions.map((s, i) =>
    `=== Session ${i + 1} (${s.session_id}) ===\n` +
    s.messages.map(m => `[${m.role}]: ${m.content}`).join('\n'),
  ).join('\n\n');

  const qaSystem = `\
你是一个记忆评测数据标注助手。根据提供的对话记录，生成一个记忆召回测试题。

【核心原则】
- 问题和答案必须完全关于「用户（user）自己」的个人信息，不能问艾玛的事情
- 用户个人信息指：用户的职业/学校/爱好/食物偏好/家人/朋友/计划/近期经历/情绪状态等
- 答案必须能从某条 [user] 消息里直接找到

问题类型：${qType}（${qTypeDesc[qType]}）

标注规则：
- has_answer 只能标注在含答案的 [user] 消息上，[assistant] 消息一律 false
- 至少 1 条 user 消息 has_answer=true
- 干扰 session 里所有消息 has_answer=false
- multi_session 类型要求 has_answer=true 的消息分布在至少 2 个不同 session 里`;

  const qaUser = `\
以下是 5 个聊天 session 的内容（每条消息格式：[role]: 内容）：

${sessionsText}

请生成一个「${qType}」类型的测试题。
注意：问题必须问「用户自己」的信息（不能问艾玛的信息）。
请标注每条消息的 has_answer（只有含答案的 [user] 消息才能为 true）。

输出格式（严格 JSON）：
{
  "question": "问题内容",
  "answer": "标准答案（简短，从对话中提取）",
  "evidence_session_ids": ["含有答案的session_id列表"],
  "annotated_sessions": [
    {
      "session_id": "s001",
      "messages": [
        {"role": "user", "content": "原消息", "has_answer": false},
        {"role": "assistant", "content": "原消息", "has_answer": false}
      ]
    }
  ]
}`;

  let qaRaw: string;
  try {
    qaRaw = await callDeepSeek(qaSystem, qaUser);
  } catch (err) {
    console.warn(`  [case ${caseIdx}] Q&A生成失败: ${(err as Error).message}`);
    return null;
  }

  let qaData: {
    question: string;
    answer: string;
    evidence_session_ids: string[];
    annotated_sessions: Array<{
      session_id: string;
      messages: Array<{ role: string; content: string; has_answer: boolean }>;
    }>;
  };
  try {
    qaData = JSON.parse(qaRaw) as typeof qaData;
  } catch {
    console.warn(`  [case ${caseIdx}] Q&A JSON解析失败`);
    return null;
  }

  // 验证：至少1条 user has_answer=true
  const anyEvidence = qaData.annotated_sessions?.some(s =>
    s.messages?.some(m => m.role === 'user' && m.has_answer === true),
  );
  if (!anyEvidence) {
    console.warn(`  [case ${caseIdx}] 无 has_answer=true 的 user 消息，丢弃`);
    return null;
  }

  // 构造 OracleCase
  const id = `ema_${String(caseIdx).padStart(3, '0')}`;
  const haystackSessions: OracleSession[] = (qaData.annotated_sessions ?? []).map(s => ({
    session_id: s.session_id,
    messages:   (s.messages ?? [])
      .filter(m => typeof m.content === 'string')
      .map(m => ({
        role:       m.role as 'user' | 'assistant',
        content:    m.content,
        has_answer: m.has_answer === true,
      })),
  }));

  return {
    question_id:       id,
    question_type:     qType,
    question:          qaData.question ?? '',
    answer:            qaData.answer   ?? '',
    haystack_sessions: haystackSessions,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function buildTypeQueue(n: number): string[] {
  const queue: string[] = [];
  for (const [type, ratio] of Object.entries(TYPE_DIST)) {
    const count = Math.round(n * ratio);
    for (let i = 0; i < count; i++) queue.push(type);
  }
  // 补全到 n（取 single_hop）
  while (queue.length < n) queue.push('single_hop');
  return queue.sort(() => Math.random() - 0.5);   // shuffle
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load partial results if resuming
  let existing: OracleCase[] = [];
  if (RESUME && fs.existsSync(PARTIAL_PATH)) {
    const prev = JSON.parse(fs.readFileSync(PARTIAL_PATH, 'utf-8')) as OracleFile;
    existing = prev.cases ?? [];
    console.log(`[gen] Resuming: ${existing.length} cases already done`);
  }

  const remaining = TARGET_N - existing.length;
  if (remaining <= 0) {
    console.log('[gen] Already at target, nothing to do. Pass --n=N to generate more.');
    return;
  }

  console.log(`[gen] Generating ${remaining} cases (target=${TARGET_N}, existing=${existing.length})`);
  console.log(`[gen] Type distribution: ${JSON.stringify(TYPE_DIST)}`);

  const typeQueue = buildTypeQueue(remaining);
  const cases = [...existing];
  let failed = 0;

  for (let i = 0; i < typeQueue.length; i++) {
    const qType   = typeQueue[i]!;
    const caseIdx = existing.length + i + 1;

    process.stdout.write(`  [${caseIdx}/${TARGET_N}] type=${qType} ... `);

    const result = await generateCase(caseIdx, qType);

    if (result) {
      cases.push(result);
      process.stdout.write(`✓ (sessions=${result.haystack_sessions.length}, evidence=${
        result.haystack_sessions.flatMap(s => s.messages).filter(m => m.has_answer).length
      })\n`);
    } else {
      failed++;
      process.stdout.write(`✗ (skipped, total failed=${failed})\n`);
    }

    // Save partial every 10 cases
    if (cases.length % 10 === 0 || i === typeQueue.length - 1) {
      const partial: OracleFile = {
        meta:  { generated_at: new Date().toISOString(), total_cases: cases.length, model: MODEL },
        cases,
      };
      fs.mkdirSync(path.dirname(PARTIAL_PATH), { recursive: true });
      fs.writeFileSync(PARTIAL_PATH, JSON.stringify(partial, null, 2), 'utf-8');
    }

    // Polite delay (avoid 429)
    if (i < typeQueue.length - 1) await delay(DELAY_MS);
  }

  // Final save
  const output: OracleFile = {
    meta:  { generated_at: new Date().toISOString(), total_cases: cases.length, model: MODEL },
    cases,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n[gen] Done. ${cases.length} cases saved → ${OUT_PATH}`);
  console.log(`[gen] Failed/skipped: ${failed}`);

  const byType: Record<string, number> = {};
  for (const c of cases) byType[c.question_type] = (byType[c.question_type] ?? 0) + 1;
  console.log('[gen] By type:', JSON.stringify(byType));
}

main().catch(err => { console.error(err); process.exit(1); });
