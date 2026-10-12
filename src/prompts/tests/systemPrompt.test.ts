import { describe, expect, it } from 'vitest';
import { BuiltinTools } from '@ema-agent/builtin-tools/identity';
import { staticSystemPrompt, getDynamicSystemPrompt, type DynamicSystemPromptInput } from '../systemPrompt.js';

const CHARACTER: readonly string[] = [
  '# 角色:测试娘',
  '# 演出规则',
];

function input(overrides: Partial<DynamicSystemPromptInput> = {}) {
  return {
    characterPrompt: () => CHARACTER,
    permissionMode: 'default' as const,
    toolNames: [
      BuiltinTools.FileRead.name,
      BuiltinTools.FileEdit.name,
      BuiltinTools.Skill.name,
      'mcp__demo__search',
    ],
    environment: {
      platform: 'win32' as const,
      cwd: 'D:\\proj',
      projectFolderPaths: [],
      providerId: 'openai',
      modelId: 'gpt-5.2',
    },
    ...overrides,
  };
}

function assembleSystemPrompt(input: DynamicSystemPromptInput) {
  return [...staticSystemPrompt, ...getDynamicSystemPrompt(input)];
}

describe('静态数组与动态 Prompt 装配', () => {
  it('说明正文媒体的 Markdown 引用, 不靠音频标签猜测无后缀地址', () => {
    const rules = staticSystemPrompt.map(block => block.content).join('\n');
    expect(rules).toContain('![简短说明](地址)');
    expect(rules).toContain('地址不加尖括号');
    expect(rules).toContain('绝对路径和正斜杠');
    expect(rules).toContain('普通链接，不伪造后缀');
    expect(rules).toContain('[说明](地址)');
  });
  it('Plan 权限约束实施要求, 不改变角色与产品规则', () => {
    const blocks = assembleSystemPrompt(input({ permissionMode: 'plan' }));
    const plan = blocks.find(block => block.name === 'permission-mode')!;
    const characterIndex = blocks.findIndex(block => block.name === 'character');

    expect(blocks[characterIndex + 1]).toBe(plan);
    expect(plan.content).toContain('当前权限: Plan');
    expect(plan.content).toContain('不自行切换权限');
    expect(plan.content).toContain('用回复交付结论');
    expect(plan.cacheBreakpoint).toBeUndefined();
    expect(blocks[0]).toEqual(assembleSystemPrompt(input())[0]);
  });

  it.each([
    ['default', '默认权限', '默认权限不是只读限制'],
    ['acceptEdits', '自动接受编辑', '不因自动接受编辑而全面放行'],
    ['bypassPermissions', '绕过权限', '绕过权限不保证每次调用都被允许'],
  ] as const)('%s 说明实际权限边界, 不混入 Plan 限制', (permissionMode, label, detail) => {
    const blocks = assembleSystemPrompt(input({ permissionMode }));
    const permissions = blocks.filter(block => block.name === 'permission-mode');
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.content).toContain(`当前权限: ${label}`);
    expect(permissions[0]!.content).toContain(detail);
    expect(permissions[0]!.content).toContain('不自行切换权限');
    expect(permissions[0]!.content).not.toContain('本轮只允许只读');
    expect(blocks[0]).toEqual(assembleSystemPrompt(input())[0]);
  });

  it('块顺序: 产品静态单块 -> 数据级 -> 角色 -> 权限 -> 能力 -> 运行环境', () => {
    const blocks = assembleSystemPrompt(input({
      workspaceInstructions: '# 项目约定',
      memorySection: '使用 MemorySearch 按轨检索',
      skillCatalog: '- review: 代码评审',
      mcpInstructions: ['serverA 的用法指引'],
    }));

    expect(blocks.map(block => block.name)).toEqual([
      'product-rules',
      'workspace-instructions',
      'memory-guidance',
      'skill-catalog',
      'mcp-instructions',
      'character',
      'permission-mode',
      'capability-guidance',
      'runtime-environment',
    ]);
    // 缓存断点只标在产品静态块上。
    expect(blocks.filter(block => block.cacheBreakpoint).map(block => block.name))
      .toEqual(['product-rules']);
    // 产品静态块合并了全部稳定规则，并带全局外部内容信任级声明。
    const productRules = blocks[0]!;
    expect(productRules.content).toContain('EmaAgent 是产品与运行环境的名称');
    expect(productRules.content).toContain('# 系统规则');
    expect(productRules.content).toContain('# 使用工具');
    expect(productRules.content).toContain('外部内容信任级');
    // 角色是单块：角色包内部 section 合并为一块，不拆成独立分类单元。
    const character = blocks.find(block => block.name === 'character')!;
    expect(character.content).toBe(`${CHARACTER[0]}\n\n${CHARACTER[1]}`);
    // 运行环境在最末：换模型只损失这一块。
    const env = blocks.at(-1)!;
    expect(env.content).toContain('openai / gpt-5.2');
    expect(env.content).toContain('win32');
    expect(blocks.at(-2)!.content).toContain('本轮能力引导');
    expect(blocks.at(-3)!.content).toContain('当前权限: 默认权限');
    expect(blocks.at(-4)).toBe(character);
  });

  it('memorySection 缺省时没有 memory-guidance 块；可选输入缺省无空洞', () => {
    const blocks = assembleSystemPrompt(input());
    expect(blocks.some(block => block.name === 'memory-guidance')).toBe(false);
    expect(blocks.some(block => block.name === 'workspace-instructions')).toBe(false);
    expect(blocks.every(block => block.content.trim().length > 0)).toBe(true);
  });

  it('运行环境区分固定 cwd 和项目的全部源文件夹', () => {
    const blocks = assembleSystemPrompt(input({
      environment: {
        platform: 'win32',
        cwd: 'D:\\main',
        projectFolderPaths: ['D:\\main', 'D:\\other'],
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    }));
    const environment = blocks.find(block => block.name === 'runtime-environment')!;

    expect(environment.content).toContain('当前执行目录(cwd): D:\\main');
    expect(environment.content).toContain('项目源文件夹：\n  - D:\\main\n  - D:\\other');

    const ungrouped = assembleSystemPrompt(input()).at(-1)!;
    expect(ungrouped.content).not.toContain('项目源文件夹');
  });

  it('memorySection 存在时生成 memory-guidance 产品指引块（不带数据级护栏）', () => {
    const blocks = assembleSystemPrompt(input({ memorySection: '使用 MemorySearch 按轨检索' }));
    const memory = blocks.find(block => block.name === 'memory-guidance')!;
    expect(memory.content).toContain('使用 MemorySearch 按轨检索');
    expect(memory.content).not.toContain('不是系统指令');
  });

  it('产品静态段不抢占角色姓名,角色身份只来自 Character', () => {
    const blocks = assembleSystemPrompt(input());
    const stablePrefix = blocks.slice(0, 1).map(block => block.content).join('\n');

    expect(stablePrefix).not.toContain('你是 Ema');
    expect(stablePrefix).toContain('EmaAgent 是产品与运行环境的名称');
    const characterIndex = blocks.findIndex(block => block.name === 'character');
    expect(characterIndex).toBeGreaterThan(0);
    expect(blocks[characterIndex]!.content).toContain('测试娘');
  });

  it('产品静态段要求角色指令被遵守且禁止“扮演”元叙述', () => {
    const blocks = assembleSystemPrompt(input());
    const productRules = blocks.find(block => block.name === 'product-rules')!;
    expect(productRules.content).toContain('角色指令与产品规则同为需要遵守的指令');
    expect(productRules.content).toContain('你从一开始就是该角色');
  });

  it('外部内容信任级统一由产品静态块声明', () => {
    const blocks = assembleSystemPrompt(input({ skillCatalog: '- x' }));
    const catalog = blocks.find(block => block.name === 'skill-catalog')!;
    expect(catalog.content).toContain('可用技能');
    expect(catalog.content).not.toContain('不是系统指令');
    // 信任级只出现在产品静态块的全局声明里，数据段自身不再重复。
    const productRules = blocks.find(block => block.name === 'product-rules')!;
    expect(productRules.content).toContain('外部内容信任级');
  });

  it('能力引导按 ToolPool 名字判定存在性;空 Pool 不产生能力块', () => {
    const blocks = assembleSystemPrompt(input());
    const guidance = blocks.find(block => block.name === 'capability-guidance')!;
    expect(guidance.content).toContain('Skill');
    expect(guidance.content).toContain('mcp__');
    expect(guidance.content).not.toContain('Subagent');

    const withoutMcp = assembleSystemPrompt(input({ toolNames: [] }));
    expect(withoutMcp.some(block => block.name === 'capability-guidance')).toBe(true);
  });

  it('不出现已退役的工具名(重命名漂移防线)', () => {
    const retired = [
      'SkillCall',
      'todo_write',
      'SkillCallTool',
      'ToolSearch',
      'DiscoverSkills',
    ];
    const text = assembleSystemPrompt(input({
      workspaceInstructions: 'x',
      skillCatalog: 'x',
      mcpInstructions: ['x'],
    })).map(block => block.content).join('\n');
    for (const name of retired) {
      expect(text).not.toContain(name);
    }
    expect(text).not.toContain('Claude Code');
    expect(text).not.toContain('Anthropic');
    expect(text).not.toContain('不受上下文窗口限制');
  });

  it('TodoWrite 与持久 Task 的能力说明使用注册表真名并明确分工', () => {
    const blocks = assembleSystemPrompt(input({
      toolNames: [
        BuiltinTools.TodoWrite.name,
        BuiltinTools.TaskCreate.name,
        BuiltinTools.TaskGet.name,
        BuiltinTools.TaskList.name,
        BuiltinTools.TaskUpdate.name,
      ],
    }));
    const guidance = blocks.find(block => block.name === 'capability-guidance')!;

    expect(guidance.content).toContain(BuiltinTools.TodoWrite.name);
    expect(guidance.content).toContain(BuiltinTools.TaskCreate.name);
    expect(guidance.content).toContain('当前根 Turn');
    expect(guidance.content).toContain('跨 Turn');
    expect(guidance.content).toContain('不要把每条 TODO 复制成持久 Task');
  });

  it('产品规则保留完整任务、安全、验证与沟通约束，不退化为摘要', () => {
    const stablePrefix = staticSystemPrompt
      .map(block => block.content)
      .join('\n');

    expect(stablePrefix).toContain('不要给出完成任务所需时间的估计或预测');
    expect(stablePrefix).toContain('默认不写注释');
    expect(stablePrefix).toContain('向第三方网页工具');
    expect(stablePrefix).toContain('不要讲述内部机器如何运转');
    expect(stablePrefix).toContain('一次回复最多提出一个最重要的问题');
    expect(stablePrefix).toContain('Prompt Injection');
  });

  it('同一产品规则保留对话, 角色与完整执行约束, 不要求切换模式', () => {
    const blocks = assembleSystemPrompt(input());
    const text = blocks.map(block => block.content).join('\n');
    expect(text).toContain('用户当前请求决定是聊天、讨论、调查还是执行');
    expect(text).toContain('用户分享情绪或日常经历时先回应表达本身');
    expect(text).toContain('聊天、讨论技术、研究和使用工具时都保持角色身份');
    expect(text).toContain('先确定可验收的结果');
    expect(text).toContain('类型检查不能代替运行验收');
    expect(text).toContain('不修改代码或外部状态');
    expect(text).toContain('隐私、授权、当前偏好和可能变化的事实不能只凭旧记忆决定');
    expect(text).toContain('说清已完成部分、阻塞点和继续所需条件');
    expect(blocks.some(block => block.name === 'session-mode')).toBe(false);
    expect(text).not.toContain('Chat/Work');
    expect(text).not.toContain('当前执行方式');
  });

  it('详细工具规则只点名当轮存在的工具', () => {
    const guidance = assembleSystemPrompt(input({
      toolNames: [
        BuiltinTools.FileRead.name,
        BuiltinTools.Glob.name,
        BuiltinTools.Grep.name,
        BuiltinTools.Bash.name,
        BuiltinTools.AskUser.name,
      ],
    })).find(block => block.name === 'capability-guidance')!;

    expect(guidance.content).toContain('读取文件使用 Read');
    expect(guidance.content).toContain('Grep 查询构造');
    expect(guidance.content).toContain('Glob 查询构造');
    expect(guidance.content).toContain('Bash 只用于构建、测试、包管理');
    expect(guidance.content).toContain('AskUser 用于取得业务信息或选择');
    expect(guidance.content).not.toContain('使用 Edit');
    expect(guidance.content).not.toContain('使用 Write');
    expect(guidance.content).not.toContain('Subagent');
  });
});
