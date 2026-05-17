"""
End-to-end narrative test: DeepSeek LLM + SiliconFlow embed
Usage:  python test_narrative_e2e.py
"""
from __future__ import annotations
import json, sys, time, urllib.request, urllib.parse

CORE_URL        = "http://localhost:3421"
BRIDGE_URL      = "http://localhost:7421"
DEEPSEEK_KEY    = "sk-48f0e582ccfa46ae85ad62917fbc9c09"
SILICONFLOW_KEY = "sk-phfezkdmvncnhkszybktohrcccvwchhfkrvcncidwrfzheev"
USER_INPUT      = "第三周目里希罗揭露了哪些人的禁忌？"

# Story content to ingest per timeline (extracted from the router's STORY_SUMMARY)
STORY_3RD_LOOP = """
第三周目：直面禁忌的审判与最终的救赎 (3rd Loop)
视角: 希罗 & 艾玛
核心: 揭露所有人的心理创伤（Taboo），集齐13名魔女。

Timeline_3rd_Loop 描述: 希罗以半魔女化的姿态回归。她不再寻求和平，而是通过极端的"魔女安息仪式"，强行揭开每个人的伤疤，迫使全员觉醒为魔女，以召唤大魔女。

第三章第一节：魔女安息仪式 (强制审判)
方法: 希罗利用前两周目的情报，在审判庭上精准打击每位少女的心理弱点（禁忌）

被揭露的禁忌列表:
- 梅露露: 害怕自己没被大魔女选中
- 蕾雅: 渴望被注视，害怕自己得不到他人的注视
- 玛格: 玛格因扭曲的爱，害怕自己被爱
- 诺亚: 害怕自己画的画被别人看见
- 奈叶香：厌恶被姐姐保护的无力感。
- 可可：目睹家人被杀却躲起来的旁观者创伤。
- 亚里沙：渴望因纵火被惩罚的罪恶感。
- 安安：害怕自己完全不被人要求负起责任
- 米莉亚：害怕自己被大肆传播的恐惧。
- 汉娜：贫穷导致的自卑与未能救妹妹的悔恨。害怕被抛弃
- 雪莉：无法感知情感的怪物本质。
- 希罗: 害怕自杀
- 最终禁忌: 樱羽艾玛的罪——"旁观者"。揭露她曾对挚友月代雪被霸凌视而不见。第13名魔女觉醒。

第三章第二节：最终审判与真结局
事件: 13名魔女集结，大魔女月代雪（Tsukishiro Yuki）降临。
揭露的真相:
- 魔女因子是雪为了复仇而散布的诅咒，旨在让人类自我毁灭。
- 雪内心依然渴望被朋友（艾玛、希罗）拯救。
解决:
- 艾玛拒绝使用"杀死魔女的魔法"去消灭雪，而是选择接纳。
- 梅露露选择与雪一同承受净化的长枪，两人消失。
真结局: 幸存的少女们恢复人类身份，玛格、诺亚、安安与奈叶香选择留下，其余人等待直升机接回。希罗与艾玛解开心结，重归于好。
"""

STORY_1ST_LOOP = """
第一周目：绝望的开始与崩坏的友情 (1st Loop)
视角: 樱羽艾玛 (Sakuraba Emma)
结局: 全灭，时间回溯

描述: 艾玛初次醒来，对现状一无所知。二阶堂希罗盲目反抗守卫并在序章即被砍头处决。少女们在恐惧中互相残杀。

第一章: 聚光灯下的虚荣
受害者: 城崎诺亚 (Kinosaki Noah)
凶手: 莲见蕾雅 (Hasumi Leia)
真相: 蕾雅因极度的表现欲和嫉妒，无法容忍诺亚夺走众人的关注，利用视线诱导魔法构造简易长矛将其杀害。蕾雅被处以铁处女刑

第二章: 封闭世界的渴望
受害者: 佐伯米莉亚 (Saeki Milia)
凶手: 夏目安安 (Natsume An-An)
真相: 大家试图制作热气球越狱，但安安因为害怕外面的世界，想要永远留在监牢，因此破坏计划并用刀反复穿刺胸口杀害了想要带大家出去的米莉亚（尽管误以为杀的是艾玛）。安安被处以人偶剧刑(被铁线操纵割喉)

第三章: 友情的极致是死亡
受害者: 远野汉娜 (Tono Hannah)
凶手: 橘雪莉 (Tachibana Sherry)
真相: 汉娜即将魔女化，恳求挚友雪莉杀死自己。雪莉为了回应这份扭曲的友情承诺，利用怪力魔法移动了整栋建筑制造密室，用绞刑绳索杀死了汉娜。雪莉被处以火刑，但以人类身份死去

第五章: 轮回的终焉
事件: 奈叶香因查探到地下设施的真相被管理者梅露露分尸灭口。幸存者寥寥无几，梅露露揭露自己是监牢管理者及真正的魔女。泽度可可魔女化并杀死了保护艾玛的玛格。
结局: 艾玛在绝望中觉醒"魔女杀手"能力，把梅露露推下油锅烧死。随后大魔女的声音响起（揭示为旧友月代雪），时间被回溯，进入第二周目。
"""

STORY_2ND_LOOP = """
第二周目：希罗的孤独回溯与正义的拷问 (2nd Loop)
视角: 二阶堂希罗 (Nikaido Hiro)
特点: 希罗保留记忆，试图独自通过严厉规则拯救所有人，却反遭误解。

描述: 希罗带着记忆回归。她误以为艾玛是灾祸之源而疏远她。本周目案件发生反转，受害者与凶手的身份互换或动机改变。

第一章: 扭曲的爱之痛
受害者: 冰上梅露露 (Hikawa Meruru)
凶手: 宝生玛格 (Hosho Margo)
真相: 第一周目的管理者梅露露率先被杀。玛格因扭曲的爱，认为杀害对方是占有的最高形式。希罗虽被陷害，但成功洗清嫌疑。玛格被控制在圆盘上被飞镖处决

第四章: 最后的轮回
受害者: 樱羽艾玛 (Sakuraba Emma) & 莲见蕾雅 (Hasumi Leia)
凶手: 远野汉娜 (Tono Hannah)
真相: 汉娜因嫉妒蕾雅的光芒而杀人，使用冰块猛击蕾雅的头部，过程中被艾玛发现，也同样用剑杀死了艾玛。雪莉为了遵守誓言，冲入石刑处刑台与汉娜一同赴死，两人都没有魔女化。希罗阅读了同伴的遗书，意识到大家的羁绊，决定利用魔女化增强魔力，上吊自杀发动最大规模的回溯。
"""


def bridge_post(path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req  = urllib.request.Request(
        f"{BRIDGE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode("utf-8"))


def post(path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req  = urllib.request.Request(
        f"{CORE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def put(path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req  = urllib.request.Request(
        f"{CORE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def get(path):
    with urllib.request.urlopen(f"{CORE_URL}{path}", timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


# ── 1. Health ──────────────────────────────────────────────────────────────────
print("\n-- 1. Health check")
try:
    h = get("/health")
    print(f"   Core: {h.get('status')}")
except Exception as e:
    print(f"   ERROR: core not reachable — {e}")
    sys.exit(1)

# ── 2. Register DeepSeek ───────────────────────────────────────────────────────
print("\n-- 2. Register DeepSeek provider (LLM)")
ds = post("/api/providers", {
    "definitionId": "deepseek",
    "displayName":  "DeepSeek (test)",
    "apiKey":       DEEPSEEK_KEY,
    "baseUrl":      "https://api.deepseek.com",
    "capabilities": ["llm"],
    "config":       {},
})
ds_id = ds["id"]
print(f"   id={ds_id}")

# ── 3. Register SiliconFlow ────────────────────────────────────────────────────
print("\n-- 3. Register SiliconFlow provider (embed)")
sf = post("/api/providers", {
    "definitionId": "siliconflow",
    "displayName":  "SiliconFlow (test)",
    "apiKey":       SILICONFLOW_KEY,
    "baseUrl":      "https://api.siliconflow.cn/v1",
    "capabilities": ["embed"],
    "config":       {},
})
sf_id = sf["id"]
print(f"   id={sf_id}")

# ── 4. Model bindings ──────────────────────────────────────────────────────────
print("\n-- 4. Set model bindings")
put("/api/model-bindings/narrative",    {"providerConfigId": ds_id, "model": "deepseek-chat"})
print("   narrative    -> deepseek-chat")
put("/api/model-bindings/lightrag-llm", {"providerConfigId": ds_id, "model": "deepseek-chat"})
print("   lightrag-llm -> deepseek-chat")
put("/api/model-bindings/embed",        {"providerConfigId": sf_id, "model": "Pro/BAAI/bge-m3"})
print("   embed        -> Pro/BAAI/bge-m3")

# Wait for bridge configure to propagate
print("   (waiting 2s for bridge configure...)")
time.sleep(2)

# ── 5. Verify bridge is ready ──────────────────────────────────────────────────
print("\n-- 5. Verify bridge narrative readiness")
try:
    req = urllib.request.Request(f"{BRIDGE_URL}/health")
    with urllib.request.urlopen(req, timeout=5) as r:
        bh = json.loads(r.read().decode("utf-8"))
    narrative_ready = bh.get("capabilities", {}).get("narrative", False)
    print(f"   Bridge narrative ready: {narrative_ready}")
    if not narrative_ready:
        print("   ERROR: bridge narrative not ready — check that /internal/configure succeeded")
        sys.exit(1)
except Exception as e:
    print(f"   ERROR: bridge not reachable — {e}")
    sys.exit(1)

# ── 6. Ingest story documents ──────────────────────────────────────────────────
print("\n-- 6. Ingest story documents into LightRAG")
print("   (this calls /narrative/ingest on the bridge directly — may take 30-120s per timeline)")

for timeline, content in [
    ("1st_Loop", STORY_1ST_LOOP),
    ("2nd_Loop", STORY_2ND_LOOP),
    ("3rd_Loop", STORY_3RD_LOOP),
]:
    print(f"   Ingesting {timeline}...", end="", flush=True)
    result = bridge_post("/narrative/ingest", {
        "timeline":  timeline,
        "documents": [content],
    })
    print(f" accepted={result.get('accepted')} ✓")

print("   All timelines ingested.")

# ── 7. POST narrative turn ─────────────────────────────────────────────────────
print(f"\n-- 7. Start narrative turn")
print(f"   Query: {USER_INPUT}")
turn      = post("/api/turns", {"mode": "narrative", "userInput": USER_INPUT})
turn_id   = turn["turnId"]
session_id = turn["sessionId"]
print(f"   turnId={turn_id}  sessionId={session_id}")

# ── 8. Stream SSE ──────────────────────────────────────────────────────────────
print("\n-- 8. SSE stream\n")

sse_url = f"{CORE_URL}/api/turns/{turn_id}/events"
req     = urllib.request.Request(sse_url, headers={"Accept": "text/event-stream"})
full_text = ""

with urllib.request.urlopen(req, timeout=120) as resp:
    buf = ""
    for raw in resp:
        line = raw.decode("utf-8").rstrip("\n\r")

        if line.startswith("data: "):
            buf += line[6:]
        elif line == "":
            if buf.strip() and buf.strip() != "{}":
                try:
                    ev = json.loads(buf)
                    t  = ev.get("type", "")

                    if t == "turn_started":
                        print(f"[turn_started] mode={ev.get('mode')}")

                    elif t == "narrative_route_resolved":
                        tl = ", ".join(ev.get("timelines", []))
                        print(f"[narrative_route_resolved] timelines: {tl}")

                    elif t == "narrative_timeline_complete":
                        print(
                            f"[narrative_timeline_complete] {ev.get('timeline')} "
                            f"-- {ev.get('charCount')} chars -- {ev.get('snippet')}"
                        )

                    elif t == "recall_evidence":
                        src = ", ".join(ev.get("sources", []))
                        print(f"[recall_evidence] sources={src} count={ev.get('itemCount')}")

                    elif t == "output_text_delta":
                        delta = ev.get("delta", "")
                        print(delta, end="", flush=True)
                        full_text += delta

                    elif t == "output_text_complete":
                        print()

                    elif t == "system_warning":
                        print(f"\n[system_warning] [{ev.get('level')}] {ev.get('message')}")

                    elif t == "turn_completed":
                        u = ev.get("usage", {})
                        print(f"\n[turn_completed] in={u.get('inputTokens')} out={u.get('outputTokens')}")
                        break

                    elif t == "turn_failed":
                        print(f"\n[turn_failed] {ev.get('code')}: {ev.get('message')}")
                        break

                    elif t == "turn_aborted":
                        print(f"\n[turn_aborted] {ev.get('reason')}")
                        break

                    elif t not in ("heartbeat", "emotion_changed"):
                        print(f"[{t}]")

                except json.JSONDecodeError:
                    pass
            buf = ""

print(f"\n-- Done ({len(full_text)} chars total)")
