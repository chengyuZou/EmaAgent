# Parser 目录说明

本目录用于将 Naninovel 脚本（`.bytes`）解析为结构化对话数据，并进一步合并成适合记忆检索/RAG 的剧情块数据。

---

## 1. 模块目标

`Parser/` 的职责可以分为三步：

1. **脚本解析**：从原始脚本中提取 `角色-台词-编号`。
2. **上下文合并**：使用滑动窗口把多句对话合并成长上下文 chunk。
3. **数据清洗映射**：修正章节编号与第三周目标识，生成可直接入库的数据。

目录中同时保留了中间产物（如单文件 JSON、合并 JSON、清洗后 JSON），方便调试与回溯。

---

## 2. 关键脚本与实现功能

## 2.1 `NaninovelParser.py`

**定位**：单脚本级解析器（适合先验验证）。

**核心能力**：

- 解析以 `#` 开头的语句 ID，识别一条新对话块开始。
- 解析以 `;` 开头的元信息行，提取说话人。
- 支持多种说话人识别路径：
  - 从 ID 后缀推断角色代码；
  - 从 `＠日文名` 映射到中文角色名；
  - 从 `Unknown:` 等通用标记回退映射。
- 处理文本清洗：
  - `<br>` 转换换行；
  - 清理 `<ruby>` 标记。
- 输出字段包含：`id`、`speaker`、`original_speaker_code`、`text`、`file_name`。

**实现特点**：

- 使用“优先级覆盖规则”避免 `Unknown` 覆盖已识别的具体角色名。
- 既兼顾叙述文本（旁白），也兼顾角色对话文本。

## 2.2 `build_dataset.py`

**定位**：全量剧情数据抽取主流程（批处理）。

**核心能力**：

- 递归遍历脚本目录，批量读取 `Act*.bytes`。
- 依据目录名 `ActXX_ChapterYY` 计算 `timeline`：
  - `1st_Loop` / `2nd_Loop` / `3rd_Loop`。
- 区分场景类型：`Adventure` 与 `Trial`。
- 处理章节内文件顺序（含特例规则）：
  - 常规章节将 Trial 插入 Adv 中段；
  - `Act02_Chapter05`、`Act02_Chapter06` 采用定制拼接逻辑。
- 解析输出保留结构元数据：
  - `timeline`、`chapter`、`file`、`id`、`type`、`speaker`、`text`。

**实现特点**：

- 在解析层内集成角色映射、文本清洗、Choice 识别。
- 通过章节级排序策略保障剧情顺序可用于后续合并。

## 2.3 `merger.py`（`ScriptMerger`）

**定位**：将逐句数据合并为上下文块。

**核心能力**：

- 采用滑动窗口策略：
  - 参数 `window_size` 控制每块句数；
  - 参数 `overlap` 控制相邻块重叠上下文。
- 每个 chunk 输出聚合信息：
  - `start_chunk_id` / `end_chunk_id`
  - `start_chapter` / `end_chapter`
  - `is_trial`
  - `speakers`（角色集合）
  - `content`（可直接做向量化的长文本）
  - `adv_index` / `trial_index`
  - `progress_score`
- 支持按章节归一化进度分数：
  - Trial 和 Adv 分别归一化到 0~1。

**实现价值**：

- 将离散台词转成“有上下文连续性”的检索单元。
- 保留剧情进度与章节位置信号，便于时序检索。

## 2.4 `new.py`（`SimpleThirdLoopMapper`）

**定位**：第三周目章节与 chunk 编号清洗映射。

**核心能力**：

- 仅处理 `timeline == 3rd_Loop` 记录。
- 映射章节：
  - `Act02_Chapter05 -> Act03_Chapter01`
  - `Act02_Chapter06 -> Act03_Chapter02`
- 映射 chunk 前缀：
  - `0205 -> 0301`
  - `0206 -> 0302`
- 提供验证逻辑：
  - 检查是否仍残留旧章节 ID；
  - 检查是否仍残留旧 chunk 前缀。

---

## 3. 数据文件说明（目录内常见产物）

- `Act01_Chapter01_Adv01.json` / `Act01_Chapter01_Adv02.json`  
  单脚本解析产物，粒度最细（逐 ID 对话）。

- `new_output.json`  
  全量抽取后的原始结构化数据（逐条台词块）。

- `norm_merged.json` / `merged.json` / `new_merged.json`  
  滑动窗口合并后的剧情 chunk 数据。

- `norm_merged_cleaned.json`  
  三周目章节与前缀映射后的清洗版结果。

- `timeline_distribution.json`  
  按时间线组织的 chunk 分布数据，便于检查各周目覆盖情况。

---

## 4. 关键字段语义

### 4.1 逐句解析层（raw）

常见字段：

- `id`：脚本行 ID（如 `0101Adv02_Ema003`）
- `speaker`：中文角色名（含“旁白/未知角色”等）
- `original_speaker_code`：原始角色代码
- `text`：清洗后的台词
- `file_name`：来源脚本名

### 4.2 合并块层（merged）

常见字段：

- `timeline`：剧情周目
- `start_chunk_id` / `end_chunk_id`：块边界
- `start_chapter` / `end_chapter`：章节边界
- `is_trial`：是否含 Trial 场景
- `speakers`：参与角色集合
- `content`：拼接文本（`角色: 台词`）
- `adv_index` / `trial_index`：剧情位置索引
- `progress_score`：章节内进度归一化分数

---

## 5. 推荐处理流程

1. 运行 `build_dataset.py` 生成全量逐句数据（如 `new_output.json`）。
2. 运行 `merger.py` 生成窗口化 chunk（如 `norm_merged.json`）。
3. 运行 `new.py` 做三周目章节清洗，产出 `norm_merged_cleaned.json`。
4. 使用 `timeline_distribution.json` 做分布检查与质量验证。

---

## 6. 适用场景

- 游戏剧情记忆库构建（RAG/向量检索）。
- 按周目、章节、角色进行剧情回放与问答。
- Trial/Adventure 混合剧情的时序检索与上下文补全。

---

## 7. 注意事项

- 角色映射规则强依赖脚本命名规范与元信息格式。
- 合并窗口参数会影响检索粒度与召回效果；`window_size` 越大，上下文越完整但定位越粗。
- 第三周目映射脚本是“规则映射”，后续若章节规则变更需同步更新字典。