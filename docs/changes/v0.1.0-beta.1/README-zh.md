# 0.1.0-beta.1

[English](./README.md)

状态: 草稿, 尚未发布.

## Narrative 调整

经过实验, 调整了 Narrative 的查询准备方式与检索参数:

- 周目判断和关键词提取改为两条独立请求并发执行. 检索与 Rerank 使用传入的 query, 不再生成各周目的子 Query.
- naive/mix 的直接原文向量粗筛最多保留 100 个候选. 每个选中周目最多送入 125 块重排, 请求最多 30 条结果.
- 图描述长度不再影响关联来源块的保留. 最终正文继续使用总计 32000 字符预算, 按选中周目均分.

数量限制统一放在 Narrative 中, 共用 Rerank 接口及其 topK 参数保持不变. 这些调整不保证剧情证据完整.

## History 滚动

- 向上滚动时补偿实测行高变化, 补入更早消息时保留阅读锚点. 真正滚回底部后恢复跟随追加消息. 源码和隔离浏览器检查通过, 安装版验收仍待完成. [问题记录](./logs/zh/historyScrolling.md).

## Live2D 兼容

- Cubism Core 升级至 `06.00.0001`, 渲染层适配 Pixi 8 和 WebGL2. 修复模型导入/预览失败和资源清理. Ema, Hiyori, Haru, Wanko 和 Ren 在发布版 CSP 下通过浏览器回归, 安装版验收仍待完成.
- 表情在自动眨眼后应用, 模型封面提高到 3072x4096. 这两项后续调整待手动实机验证.

## 上传额度

- 普通 JSON 和 Turn 请求体上限提高到 128 MiB, 音频和壁纸上传提高到 256 MiB. Live2D 封面允许最大 100 MiB 的 PNG 数据, 另计 base64 传输增量.

模块说明见 [Narrative](../../../src/narrative/README-zh.md), 先前记录见 [Alpha](../v0.1.0-alpha.1/README-zh.md).
