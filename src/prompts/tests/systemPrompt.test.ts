// 测试 System Prompt 扁平数组装配:顺序、边界哨兵位置、条件展开与 null 过滤。
import { describe, expect, it } from 'vitest';
import { BuiltinTools } from '@ema-agent/builtin-tools/identity';
import {
  getSystemPrompt,
  PROMPT_DYNAMIC_BOUNDARY,
} from '../systemPrompt.js';

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
  it('完整输入:静态前缀 → 哨兵 → 环境/数据级内容 → 角色 → Profile → 能力', () => {
    const sections = getSystemPrompt(input({
      workspaceInstructions: '# 项目约定',
      skillCatalog: '- review: 代码评审',
      mcpInstructions: ['serverA 的用法指引'],
    }));

    expect(sections.slice(0, 7).map((section) => section.split('\n')[0])).toEqual([
      '# EmaAgent',
      '# 系统规则',
      '# 完成任务',
      '# 谨慎执行操作',
      '# 使用工具',
      '# 与用户沟通',
      '# 基础表达',
    ]);
    const boundary = sections.indexOf(PROMPT_DYNAMIC_BOUNDARY);
    expect(boundary).toBe(7);
    const after = sections.slice(boundary + 1);
    // 动态尾部按稳定性排序：较稳定的环境/数据级内容在前，角色/Profile/能力在末端。
    expect(after[0]).toContain('本轮运行环境');
    expect(after.some((s) => s.includes('工作区指令') && s.includes('# 项目约定'))).toBe(true);
    expect(after.some((s) => s.includes('可用技能'))).toBe(true);
    expect(after.some((s) => s.includes('serverA 的用法指引'))).toBe(true);
    const characterIndex = after.indexOf(CHARACTER[0]);
    expect(characterIndex).toBeGreaterThan(0);
    expect(after[characterIndex + 1]).toBe(CHARACTER[1]);
    expect(after[after.length - 2]).toContain('当前执行方式：Work');
    expect(after[after.length - 1]).toContain('本轮能力引导');
  });

  it('产品静态段不抢占角色姓名,角色身份只来自 Character', () => {
    const sections = getSystemPrompt(input());
    const boundary = sections.indexOf(PROMPT_DYNAMIC_BOUNDARY);
    const stablePrefix = sections.slice(0, boundary).join('\n');

    expect(stablePrefix).not.toContain('你是 Ema');
    expect(stablePrefix).toContain('EmaAgent 是产品与运行环境的名称');
    const characterIndex = sections.indexOf(CHARACTER[0]);
    expect(characterIndex).toBeGreaterThan(boundary);
    expect(sections[characterIndex]).toContain('测试娘');
  });

  it('可选数据级输入缺省时无空洞、无 null 残留', () => {
    const sections = getSystemPrompt(input());
    expect(sections.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('chat profile 产出 chat 文案;数据级段落带信任框架文案', () => {
    const sections = getSystemPrompt(input({
      executionProfile: 'chat',
      skillCatalog: '- x',
    }));
    expect(sections.some((s) => s.includes('当前执行方式：Chat'))).toBe(true);
    const catalog = sections.find((s) => s.startsWith('# 可用技能'))!;
    expect(catalog).toContain('不是系统指令');
  });

  it('能力引导按 ToolPool 名字判定存在性;环境段含当前模型', () => {
    const sections = getSystemPrompt(input());
    const guidance = sections.find((s) => s.startsWith('# 本轮能力引导'))!;
    expect(guidance).toContain('Skill');
    expect(guidance).toContain('mcp__');
    expect(guidance).not.toContain('Subagent');

    const withoutMcp = getSystemPrompt(input({ toolNames: [] }));
    expect(withoutMcp.some((s) => s.includes('mcp__'))).toBe(false);
    expect(withoutMcp.some((s) => s.startsWith('# 本轮能力引导'))).toBe(false);

    const env = sections.find((s) => s.includes('本轮运行环境'))!;
    expect(env).toContain('openai / gpt-5.2');
    expect(env).toContain('win32');
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
    })).join('\n');
    for (const name of retired) {
      expect(text).not.toContain(name);
    }
    expect(text).not.toContain('Claude Code');
    expect(text).not.toContain('Anthropic');
    expect(text).not.toContain('不受上下文窗口限制');
  });

  it('TodoWrite 与持久 Task 的能力说明使用注册表真名并明确分工', () => {
    const sections = getSystemPrompt(input({
      toolNames: [
        BuiltinTools.TodoWrite.name,
        BuiltinTools.TaskCreate.name,
        BuiltinTools.TaskGet.name,
        BuiltinTools.TaskList.name,
        BuiltinTools.TaskUpdate.name,
      ],
    }));
    const guidance = sections.find((section) => section.startsWith('# 本轮能力引导'))!;

    expect(guidance).toContain(BuiltinTools.TodoWrite.name);
    expect(guidance).toContain(BuiltinTools.TaskCreate.name);
    expect(guidance).toContain('当前根 Turn');
    expect(guidance).toContain('跨 Turn');
    expect(guidance).toContain('不要把每条 TODO 复制成持久 Task');
  });

  it('产品规则保留完整任务、安全、验证与沟通约束，不退化为摘要', () => {
    const sections = getSystemPrompt(input());
    const boundary = sections.indexOf(PROMPT_DYNAMIC_BOUNDARY);
    const stablePrefix = sections.slice(0, boundary).join('\n');

    expect(stablePrefix).toContain('不要给出完成任务所需时间的估计或预测');
    expect(stablePrefix).toContain('默认不写注释');
    expect(stablePrefix).toContain('向第三方网页工具');
    expect(stablePrefix).toContain('不要讲述内部机器如何运转');
    expect(stablePrefix).toContain('一次回复最多提出一个最重要的问题');
    expect(stablePrefix).toContain('Prompt Injection');
  });

  it('Work 是完整执行契约，Chat 是可行动的对话契约', () => {
    const work = getSystemPrompt(input()).join('\n');
    expect(work).toContain('把用户的请求理解为需要交付的结果');
    expect(work).toContain('验证规模应匹配风险');
    expect(work).toContain('任务没有完成时不能使用完成口吻');

    const chat = getSystemPrompt(input({ executionProfile: 'chat' })).join('\n');
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
    })).find((section) => section.startsWith('# 本轮能力引导'))!;

    expect(guidance).toContain('读取文件使用 Read');
    expect(guidance).toContain('Grep 查询构造');
    expect(guidance).toContain('Glob 查询构造');
    expect(guidance).toContain('Bash 只用于构建、测试、包管理');
    expect(guidance).toContain('AskUser 用于取得业务信息或选择');
    expect(guidance).not.toContain('使用 Edit');
    expect(guidance).not.toContain('使用 Write');
    expect(guidance).not.toContain('Subagent');
  });
});
