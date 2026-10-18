# Skills

[English](./README.md)

本包发现 SKILL.md, 维护技能目录, 按 Turn 应用启停设置, 并从 SkillHub 和 ClawHub 安装技能.

## 身份和入口

技能身份是 SKILL.md 的绝对路径, 同名技能用不同路径区分. Frontmatter 提供 name, 可选 version, description 和可选 when-to-use. 读取目录不等于把技能正文交给模型.

- `SkillStore(profileDb, userRoot, builtinRoot)` 扫描本地目录, 保存索引和开关, 完成安装并删除本地技能.
- `createSkillRegistry({ store })` 创建注册表. 启动时先调用 `refreshCore`, 再读取 builtin 和 user 目录. `list(folderPaths)` 额外读取指定项目文件夹的技能.
- `freezeSkillPool` 过滤禁用路径和项目来源, 按作用域, 名称, 路径排序, 建立本 Turn 的路径查找表.
- `renderSkillListing` 生成系统提示词中的技能目录. Skill 工具使用同一个池查找路径, 调用时才读取完整 SKILL.md.
- `createMarketService` 提供市场列表, 详情, 预览和来源状态; `createMarketInstaller` 安装和卸载市场技能.

用法示例见英文 README. 宿主从 `disabledProjectSourcesSetting` 读取禁用来源, 而 `workspaceInstructionFilesSetting` 选择 CLAUDE.md 和 AGENTS.md 工作区指令文件, 拼接顺序也依此排列.

## 扫描和 Turn 使用

builtin 来自 profile 内的应用技能副本, user 来自用户目录, 两者都在 profile SQLite 的 skills 表保存索引和逐技能开关. user 也支持手动放入技能. 两类扫描只读取根目录的直接子目录.

重扫更新元数据, 保留已有 enabled 和 installed_at. 损坏技能不出现在目录里, 但保留索引和开关; 目录消失才删除索引. 根目录读取失败会抛错, 不能把它当成所有技能都被删除.

注册表按顺序执行 core 重扫. 目录读取等待首次装载, 不等待后续重扫. Project 从当前文件夹下的 .agents/skills, .claude/skills, .codex/skills, .cursor/skills, .gemini/skills 扫描, 按文件夹清单缓存, 显式调用 `refreshProjectFolders` 才更新. 不把 project 写进 skills 表, 来源开关由设置保存.

Project 扫描跳过隐藏条目和符号链接, 最深 6 层, 每个生态根最多遍历 2,000 个目录. 文件夹最多 5 路并发, 文件解析最多 16 路. Session 属于项目时使用该项目全部文件夹, 没有项目时使用 cwd, 空项目不添加 project 技能. 设置路由, Turn 准备和手动 compact 使用相同规则.

SkillPool 固定本 Turn 可见的目录, 安装或启停在下一 Turn 生效. 它不复制正文, Skill 工具调用时读取磁盘上的当前文件. Prompt 只包含 name, path, description, whenToUse. 描述最多 250 个 UTF-16 码元, 条目总预算为 8 KiB UTF-8, 超限后追加省略数量. 条目间换行和省略提示额外计算, 所以返回字符串不保证严格小于 8 KiB.

用户选中的技能以 `{ type: 'skill_reference', name, path }` 存在 Session 消息中. name 用于历史展示, path 与当前池核对. Skill 工具返回含 frontmatter 的完整 SKILL.md 和资源目录提示, 不固定磁盘文件的版本.

## 安装和删除

市场列表合并两个来源, 在当前结果批次内去掉重复身份并合并对应镜像, 再按下载数排序. 每次请求根据本地目录和 .ema-market.json 身份标记判断安装状态.

市场数据保存在进程内缓存: 列表 5 分钟, 搜索 2 分钟, 详情 10 分钟, 文件预览 30 分钟, 最多 500 项. 列表和详情请求失败时可以返回旧缓存并附带来源状态. ClawHub 搜索没有下一页 cursor, 最多取 50 项. 合并 cursor 分别保存两个来源的下一页位置.

安装重新读取文件清单, 校验可跨平台使用的相对路径, 文件大小和已有 SHA-256, 再把文本文件写进 userRoot 内的临时目录. 最多 200 个文件, 单文件 5 MiB, 总计 20 MiB. 有效 SKILL.md 和来源标记写完后, `finalizeInstall` 替换目标目录并保存索引, 保留已有索引的启停状态. 替换先删除目标再 rename, 因而 rename 失败时不具备事务回滚能力.

不同技能可以并发下载, 相同来源和 slug 的重复安装会被拒绝. 正常结束或失败均清理临时目录, 启动时 `sweepOrphanStaging` 清理中断留下的目录. 市场卸载要求来源标记匹配. 本地 builtin/user 删除分别检查目标是对应根目录下的直接普通目录. 删除 builtin 只影响 profile 副本, 保留根目录, 普通重启不会重新铺设该技能.

Server 路由在安装或删除后刷新注册表, 然后发出 `skills_changed`; 启停和重扫路由也发送此事件. 事件不带目录数据, Desktop 已打开的视图重新查询.

## 阅读和验证

目录生命周期和 Turn 选择看 `registry.ts`, `skillPool.ts`; 文件和索引写入看 `store.ts`; 项目扫描看 `sources/project.ts`. 市场浏览在 `sources/market/marketService.ts`, 安装在 `installService.ts`. HTTP 调用方在 `apps/server/src/routes/skills`, 模型调用方在 `src/builtin-tools/tools/SkillTool`.

运行 `pnpm --filter @ema-agent/skills test`. 测试使用临时目录和真实 profile SQLite 验证扫描, 启停, 本地安装删除和注册表刷新. 项目测试覆盖多文件夹, 隐藏目录, 深度和系统允许创建的符号链接. 市场测试使用模拟来源检查重复身份和本地安装标记, 不验证真实上游下载或完整远程安装.
