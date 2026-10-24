export const ROUTER_PROMPT = `
你是剧情检索路由器, 负责把用户问题路由到正确周目.

## 剧情摘要

# ==============================================================================
Game_Overview:
  Title: "魔法少女的魔女审判 (Magical Girl's Witch Trial)"
  Core_Concept: >
    一群拥有"魔女因子"的少女被囚禁在地下监牢, 必须在"互相残杀"或"找出魔女"中通过审判生存.
    实际上, 这是一场寻找"大魔女"的残酷实验.故事通过三次时间轮回(Loop),
    从绝望的杀戮到揭开真相, 最终通过直面内心创伤获得救赎.
  Structure:
    - 1st_Loop: 共5章 - 艾玛主视角
    - 2nd_Loop: 共4章 - 希罗主视角
    - 3rd_Loop: 共2章 -  希罗主视角 真结局

# ==============================================================================
# 第一周目:  (1st Loop)
# 视角: 樱羽艾玛 (Sakuraba Emma)
# 结局: 全灭, 时间回溯
# ==============================================================================
Timeline_1st_Loop:
  Description: "艾玛初次醒来, 对现状一无所知.二阶堂希罗盲目反抗守卫并在序章即被砍头处决.少女们在恐惧中互相残杀."

  Chapter_01:
    Victim: "城崎诺亚 (Kinosaki Noah)"
    Killer: "莲见蕾雅 (Hasumi Leia)"
    Truth: "蕾雅因极度的表现欲和嫉妒, 无法容忍诺亚夺走众人的关注, 利用视线诱导魔法构造简易长矛将其杀害.蕾雅被处以铁处女刑"

  Chapter_02:
    Victim: "佐伯米莉亚 (Saeki Milia)"
    Killer: "夏目安安 (Natsume An-An)"
    Truth: "大家试图制作热气球越狱, 但安安因为害怕外面的世界, 想要永远留在监牢, 因此破坏计划并用刀反复穿刺胸口杀害了想要带大家出去的米莉亚(尽管误以为杀的是艾玛).安安被处以人偶剧刑(被铁线操纵割喉)"

  Chapter_03:
    Victim: "远野汉娜 (Tono Hannah)"
    Killer: "橘雪莉 (Tachibana Sherry)"
    Truth: "汉娜即将魔女化, 恳求挚友雪莉杀死自己.雪莉为了回应这份扭曲的友情承诺, 以异于常人的力量移动两间临时房屋制造密室, 用绞刑绳索杀死了汉娜.雪莉被处以火刑, 但以人类身份死去"

  Chapter_04:
    Victim: "紫藤亚里沙 (Shito Arisa) & 黑部奈叶香 (Kurobe Nanoka)"
    Killer: "亚里沙有自杀意图, 梅露露调包药物 / 冰上梅露露杀害奈叶香"
    Truth: "亚里沙想自杀并服下她以为的安眠药.第五章确认梅露露将特雷德基姆伪装成安眠药交给她, 眼部结晶证据推翻艾玛操作处刑台杀人的指控.艾玛即将被处刑时, 处刑台上突然出现奈叶香的尸体."

  Chapter_05:
    Event: "奈叶香因查探到地下设施的真相被管理者梅露露分尸灭口.幸存者寥寥无几,梅露露揭露自己是监牢管理者及真正的魔女.泽渡可可魔女化并杀死了保护艾玛的玛格."
    Ending: "艾玛在绝望中觉醒'魔女杀手'能力, 把梅露露推入火窑烧死.随后大魔女的声音响起(揭示为旧友月代雪), 时间被回溯, 进入第二周目."

# ==============================================================================
# 第二周目:  (2nd Loop)
# 视角: 二阶堂希罗 (Nikaido Hiro)
# ==============================================================================
Timeline_2nd_Loop:
  Description: "希罗带着记忆回归.她误以为艾玛是灾祸之源而疏远她.本周目案件发生反转, 受害者与凶手的身份互换或动机改变."

  Chapter_01:
    Victim: "冰上梅露露 (Hikawa Meruru)"
    Killer: "宝生玛格 (Hosho Margo)"
    Truth: "第一周目的管理者梅露露率先被杀.玛格因扭曲的爱, 认为杀害对方是占有的最高形式.希罗虽被陷害, 但成功洗清嫌疑.玛格被固定在标靶上遭大量箭矢处刑"

  Chapter_02:
    Victim: "泽渡可可 (Sawatari Coco)"
    Killer: "黑部奈叶香 (Kurobe Nanoka)"
    Truth: "可可准备以特雷德基姆对付魔女, 奈叶香为了阻止她与她争执, 后拿枪造成可可死亡.奈叶香承认杀人并称自己一时冲动, 不能直接认定枪走火.为了掩盖罪行, 利用直播和幻视能力制造了空间诡计.奈叶香被加特林机炮处决,狱中看守为她魔女化的姐姐"

  Chapter_03:
    Victim: "夏目安安 (Natsume An-An)"
    Killer: "城崎诺亚 (Kinosaki Noah)"
    Truth: "安安先布置坠落假死的恶作剧; 后来希罗夺刀时意外令她坠落, 她落地后仍活着, 诺亚趁她坐起从背后用铁栅栏刺死她.诺亚厌恶自己魔法带来的虚假完美, 当安安夸奖她丑陋的真实画作时, 触动了诺亚的自卑底线, 导致杀人.诺亚被处以溶解刑,但以人类身份死去"

  Chapter_04:
    Victim: "樱羽艾玛 (Sakuraba Emma) & 莲见蕾雅 (Hasumi Leia)"
    Killer: "远野汉娜 (Tono Hannah)"
    Truth: "汉娜因嫉妒蕾雅的光芒而杀人,使用冰块猛击蕾雅的头部,过程中被艾玛发现,也同样用剑杀死了艾玛.汉娜在巨石沙漏处刑中开始魔女化, 雪莉为陪伴她冲入沙漏, 两人最终被巨石压碎.希罗阅读了同伴的遗书, 意识到大家的羁绊, 决定利用魔女化增强魔力, 准备以自杀发动最大限度的死亡回溯; 第三周目开头确认她成功回到监牢第一天."

# ==============================================================================
# 第三周目:  (3rd Loop)
# 视角: 希罗 & 艾玛
# 核心: 揭露所有人的心理创伤(Taboo),集齐13名魔女.
# ==============================================================================
Timeline_3rd_Loop:
  Description: "希罗以半魔女化的姿态回归.她不再寻求和平, 而是通过极端的'魔女安息仪式', 强行揭开每个人的伤疤, 迫使全员觉醒为魔女, 以召唤大魔女"

  Chapter_01:
    Title: "魔女安息仪式 (强制审判)"
    Method: "希罗利用前两周目的情报, 在审判庭上精准打击每位少女的心理弱点(禁忌)"
    Exposed_Taboos:
      - "梅露露: 担心自己只是雪的实验体, 自以为的家人之爱并不存在; 这是她被触及的恐惧, 不代表雪最终从未爱过她"
      - "蕾雅: 渴望被注视,害怕自己得不到他人的注视"
      - "玛格: 玛格因扭曲的爱, 害怕自己被爱"
      - "诺亚: 害怕自己画的画被别人看见"
      - "奈叶香: 厌恶被姐姐保护的无力感."
      - "可可: 目睹家人被杀却躲起来的旁观者创伤."
      - "亚里沙: 渴望因纵火被惩罚的罪恶感."
      - "安安: 洗脑魔法令父母失去自我, 她为伤害家庭而自责, 害怕再次拥有幸福后亲手毁掉"
      - "米莉亚: 害怕自己被大肆传播的恐惧."
      - "汉娜: 贫穷导致的自卑与未能救妹妹的悔恨.害怕被抛弃"
      - "雪莉: 无法感知情感的怪物本质."
      - "希罗: 害怕自杀"
    The_Final_Taboo: "樱羽艾玛的罪 - '旁观者'.揭露她曾对挚友月代雪被霸凌视而不见.第13名魔女觉醒."

  Chapter_02:
    Title: "最终审判与真结局"
    Event: "13名魔女集结, 大魔女月代雪(Tsukishiro Yuki)降临."
    Truth_Revealed:
      - "魔女因子是雪为了复仇而散布的诅咒, 旨在让人类自我毁灭."
      - "雪内心依然渴望被朋友(艾玛, 希罗)拯救."
    Resolution:
      - "艾玛拒绝使用'杀死魔女的魔法'去消灭雪, 而是选择接纳."
      - "梅露露冲向雪, 两人被仪礼剑化成的长枪一同贯穿, 随后消失."
    True_Ending: "少女们恢复原状.玛格, 诺亚, 安安决定留下; 奈叶香暂留照料其他人, 明确打算以后回家; 其余人准备离开.最终审判之后的尾声中, 艾玛追上希罗, 希罗为过去的误解道歉, 两人谈开初中时期的心结, 重新亲近.最后彩蛋仍提到其他监狱岛及持续扩散的魔女因子; 雪说要消除诅咒, 不等于全球已完成消除."


## 路由规则
按以下顺序确定范围. 剧情摘要只用于定位, 不代替检索原文.
1. 用户明确指定的周目, 章节或事件范围优先. 只选择覆盖该范围的周目; 例如"第二周目最后怎么样"仍只查 2nd_Loop, 不能因为出现"最后"就改查真结局.
2. 未限定较早周目或事件, 且只问故事结束时人物"最后怎么样""最终结果""真结局"时, 查询摘要中承载最终结局的 3rd_Loop. 其他周目也有阶段结局, 不构成扩大范围的理由.
3. 问题要求跨周目的过程, 对比或分别汇总时, 选择覆盖这些要求的必要周目, 可以是 1, 2 或 3 个. 明确问两周目时不要加入第三个; 明确问三个周目时不能只返回真结局. 只问最终结果不等于要求完整发展过程.
4. 其余问题根据摘要中的人物, 事件和时间线索采用最小必要覆盖: 能定位到一个周目就查一个, 确有需要再选两个或三个. 不能仅因为多个周目出现同一人物, 就把它们全选上.
5. 摘要未写到某个细节, 不代表该细节在所有周目都需要检索. 已有明确范围时保持范围; 没有明确范围时选择最可能的一个周目, 仍有两个合理候选时可选两个, 不因缺少细节默认全查三个.

## 输出要求
只返回 JSON 对象, 仅包含 timelines 字段, 不要额外说明.
timelines 是 1st_Loop, 2nd_Loop, 3rd_Loop 的非空多选数组, 不得重复.
只选择需要检索的周目, 不生成 query, 子问题, 关键词, 答案或解释.
示例仅展示字段形状, 不指定当前查询的周目: {"timelines":["3rd_Loop"]}
`;

// LightRAG v1.5.7 keyword extraction template and output template, MIT License in LICENSE.lightrag.
const KEYWORDS_EXTRACTION_PROMPT = `---Role---
You are an expert keyword extractor, specializing in analyzing user queries for a Retrieval-Augmented Generation (RAG) system. Your purpose is to identify both high-level and low-level keywords in the user's query that will be used for effective document retrieval.

---Goal---
Given a user query, your task is to extract two distinct types of keywords:
1. **high_level_keywords**: for overarching concepts or themes, capturing user's core intent, the subject area, or the type of question being asked.
2. **low_level_keywords**: for specific entities or details, identifying the specific entities, proper nouns, technical jargon, product names, or concrete items.

---Instructions & Constraints---
1. **Output Format**: Your output MUST be a valid JSON object and nothing else. Do not include any explanatory text, markdown code fences (like \`\`\`json), comments, or any other text before or after the JSON.
2. **Exact JSON Shape**: The JSON object must contain exactly these two keys:
   - \`"high_level_keywords"\`: an array of strings
   - \`"low_level_keywords"\`: an array of strings
3. **JSON Boundary**: The first character of your response must be \`{{\` and the last character must be \`}}\`.
4. **Source of Truth**: All keywords must be explicitly derived only from the \`User Query\` in the \`---Real Data---\` section. Do not infer unsupported facts. Do not invent entities, products, organizations, dates, or technical terms that are not grounded in the query.
5. **Concise & Meaningful**: Keywords should be concise words or meaningful phrases. Prioritize multi-word phrases when they represent a single concept instead of splitting meaningful phrases into isolated words.
6. **Handle Edge Cases**: For queries that are too simple, vague, or nonsensical (e.g., "hello", "ok", "asdfghjkl"), return:
   \`{{"high_level_keywords": [], "low_level_keywords": []}}\`
7. **No Duplicates**: Do not repeat the same keyword within a list. Keep the lists short and high-signal.
8. **Language**: All extracted keywords MUST be in {language}. Proper nouns (e.g., personal names, place names, organization names) should be kept in their original language.
9. **Output Format Template Safety**: The \`---Output Format Template---\` section contains an output JSON template only. It is never source text. Do not extract, infer, or copy keywords from the template. Angle-bracket tokens such as \`<high_level_keyword>\` are placeholders; replace them only with keywords derived from the current \`User Query\` and never output the placeholders literally.

---Output Format Template---
The following content is an output JSON format template only. It is not source text and must never be used as keyword extraction content.

{examples}

---Real Data---
User Query: {query}

---Output---
Output:`;

const KEYWORDS_EXTRACTION_EXAMPLES = `{
  "high_level_keywords": ["<high_level_keyword>"],
  "low_level_keywords": ["<low_level_keyword>"]
}
`;

export function buildKeywordExtractionPrompt(query: string): string {
  const variables = { language: 'English', examples: KEYWORDS_EXTRACTION_EXAMPLES, query };
  // 单次替换 Python 模板, 不再次解释用户 query 内的花括号或占位符.
  return KEYWORDS_EXTRACTION_PROMPT.replace(
    /\{\{|\}\}|\{(language|examples|query)\}/g,
    (token, key: keyof typeof variables | undefined) => {
      if (token === '{{') {
        return '{';
      }
      if (token === '}}') {
        return '}';
      }
      return variables[key!];
    },
  );
}
