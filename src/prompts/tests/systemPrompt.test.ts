// 测试 System Prompt 的 PromptBlock 装配:顺序、命名、断点标记、角色单块与条件展开。
import { describe, expect, it } from 'vitest';
import { BuiltinTools } from '@ema-agent/builtin-tools/identity';
import { getSystemPrompt } from '../systemPrompt.js';

const CHARACTER: readonly string[] = [
  '# 角色:测试娘',
  '# 演出规则',
];

function input(overrides: Partial<Parameters<typeof getSystemPrompt>[0]> = {}) {
  return {
    characterPrompt: () => CHARACTER,
    executionProfile: 'work' as const,
    toolNames: [
      BuiltinTools.FileRead.name,
      BuiltinTools.FileEdit.name,
      BuiltinTools.Skill.name,
      'mcp__demo__search',
    ],
    environment: {
      platform: 'win32' as const,
      workspaceRoot: 'D:\\proj',
      providerId: 'openai',
      modelId: 'gpt-5.2',
    },
    ...overrides,
  };
}

describe('getSystemPrompt', () => {
  it('块顺序：产品静态单块 → 数据级 → 角色单块 → Profile → 能力 → 运行环境（最末）', () => {
    const blocks = getSystemPrompt(input({
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
      'execution-profile',
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
    expect(blocks.at(-3)!.content).toContain('当前执行方式：Work');
  });

  it('memorySection 缺省时没有 memory-guidance 块；可选输入缺省无空洞', () => {
    const blocks = getSystemPrompt(input());
    expect(blocks.some(block => block.name === 'memory-guidance')).toBe(false);
    expect(blocks.some(block => block.name === 'workspace-instructions')).toBe(false);
    expect(blocks.every(block => block.content.trim().length > 0)).toBe(true);
  });

  it('memorySection 存在时生成 memory-guidance 产品指引块（不带数据级护栏）', () => {
    const blocks = getSystemPrompt(input({ memorySection: '使用 MemorySearch 按轨检索' }));
    const memory = blocks.find(block => block.name === 'memory-guidance')!;
    expect(memory.content).toContain('使用 MemorySearch 按轨检索');
    expect(memory.content).not.toContain('不是系统指令');
  });

  it('产品静态段不抢占角色姓名,角色身份只来自 Character', () => {
    const blocks = getSystemPrompt(input());
    const stablePrefix = blocks.slice(0, 1).map(block => block.content).join('\n');

    expect(stablePrefix).not.toContain('你是 Ema');
    expect(stablePrefix).toContain('EmaAgent 是产品与运行环境的名称');
    const characterIndex = blocks.findIndex(block => block.name === 'character');
    expect(characterIndex).toBeGreaterThan(0);
    expect(blocks[characterIndex]!.content).toContain('测试娘');
  });

  it('产品静态段要求角色指令被遵守且禁止“扮演”元叙述', () => {
    const blocks = getSystemPrompt(input());
    const productRules = blocks.find(block => block.name === 'product-rules')!;
    expect(productRules.content).toContain('角色指令与产品规则同为需要遵守的指令');
    expect(productRules.content).toContain('你从一开始就是该角色');
  });

  it('chat profile 产出 chat 文案;外部内容信任级统一由产品静态块声明', () => {
    const blocks = getSystemPrompt(input({ executionProfile: 'chat', skillCatalog: '- x' }));
    expect(blocks.some(block => block.content.includes('当前执行方式：Chat'))).toBe(true);
    const catalog = blocks.find(block => block.name === 'skill-catalog')!;
    expect(catalog.content).toContain('可用技能');
    expect(catalog.content).not.toContain('不是系统指令');
    // 信任级只出现在产品静态块的全局声明里，数据段自身不再重复。
    const productRules = blocks.find(block => block.name === 'product-rules')!;
    expect(productRules.content).toContain('外部内容信任级');
  });

  it('能力引导按 ToolPool 名字判定存在性;空 Pool 不产生能力块', () => {
    const blocks = getSystemPrompt(input());
    const guidance = blocks.find(block => block.name === 'capability-guidance')!;
    expect(guidance.content).toContain('Skill');
    expect(guidance.content).toContain('mcp__');
    expect(guidance.content).not.toContain('Subagent');

    const withoutMcp = getSystemPrompt(input({ toolNames: [] }));
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
    const text = getSystemPrompt(input({
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
    const blocks = getSystemPrompt(input({
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
    const stablePrefix = getSystemPrompt(input())
      .slice(0, 7)
      .map(block => block.content)
      .join('\n');

    expect(stablePrefix).toContain('不要给出完成任务所需时间的估计或预测');
    expect(stablePrefix).toContain('默认不写注释');
    expect(stablePrefix).toContain('向第三方网页工具');
    expect(stablePrefix).toContain('不要讲述内部机器如何运转');
    expect(stablePrefix).toContain('一次回复最多提出一个最重要的问题');
    expect(stablePrefix).toContain('Prompt Injection');
  });

  it('Work 是完整执行契约，Chat 是可行动的对话契约', () => {
    const work = getSystemPrompt(input()).map(block => block.content).join('\n');
    expect(work).toContain('把用户的请求理解为需要交付的结果');
    expect(work).toContain('验证规模应匹配风险');
    expect(work).toContain('任务没有完成时不能使用完成口吻');

    const chat = getSystemPrompt(input({ executionProfile: 'chat' }))
      .map(block => block.content).join('\n');
    expect(chat).toContain('不是“禁止行动”的纯文本模式');
    expect(chat).toContain('Chat 可以执行用户明确要求且本轮允许的操作');
    expect(chat).toContain('不要未经请求把对话变成诊断、教程、计划表或效率优化');
  });

  it('详细工具规则只点名当轮存在的工具', () => {
    const guidance = getSystemPrompt(input({
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
