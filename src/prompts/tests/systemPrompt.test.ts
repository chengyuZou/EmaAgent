import { describe, expect, it } from 'vitest';
import { BuiltinTools } from '@ema-agent/builtin-tools/identity';
import {
  staticSystemPrompt,
  getDynamicSystemPrompt,
  type DynamicSystemPromptInput,
  type PromptBlock,
} from '../index.js';

const CHARACTER = ['# 角色: 测试娘', '# 演出规则'];

function input(overrides: Partial<DynamicSystemPromptInput> = {}): DynamicSystemPromptInput {
  return {
    characterPrompt: () => CHARACTER,
    permissionMode: 'default',
    toolNames: [
      BuiltinTools.FileRead.name,
      BuiltinTools.FileEdit.name,
      BuiltinTools.Skill.name,
      'mcp__demo__search',
    ],
    environment: {
      platform: 'win32',
      cwd: 'D:/project',
      projectFolderPaths: [],
      providerId: 'openai',
      modelId: 'test-model',
    },
    ...overrides,
  };
}

function assemble(overrides: Partial<DynamicSystemPromptInput> = {}): readonly PromptBlock[] {
  return [...staticSystemPrompt, ...getDynamicSystemPrompt(input(overrides))];
}

function contentStartingWith(blocks: readonly PromptBlock[], heading: string): string {
  const block = blocks.find(entry => entry.content.startsWith(heading));
  if (!block) throw new Error(`Missing prompt content: ${heading}`);
  return block.content;
}

describe('system prompt assembly', () => {
  it('preserves the order of supplied data, character, permission, capabilities and environment', () => {
    const blocks = assemble({
      workspaceInstructions: '# 项目约定',
      memorySection: 'Memory 使用指引',
      skillCatalog: '- review: 代码评审',
    });
    expect(blocks[0]).toBe(staticSystemPrompt[0]);
    expect(blocks.slice(1).map(block => block.content.split('\n')[0])).toEqual([
      '# 工作区指令',
      'Memory 使用指引',
      '# 可用技能',
      CHARACTER[0],
      '# 当前权限: 默认权限',
      '# 本轮能力引导',
      '# 本轮运行环境',
    ]);
    expect(blocks.filter(block => block.cacheBreakpoint)).toEqual([staticSystemPrompt[0]]);
    expect(blocks.every(block => !('name' in block))).toBe(true);
  });

  it('omits absent or blank optional content without leaving empty blocks', () => {
    const blocks = getDynamicSystemPrompt(input({
      characterPrompt: undefined,
      workspaceInstructions: '',
      memorySection: '   ',
      skillCatalog: null,
    }));
    expect(blocks.map(block => block.content.split('\n')[0])).toEqual([
      '# 当前权限: 默认权限',
      '# 本轮能力引导',
      '# 本轮运行环境',
    ]);
    expect(blocks.every(block => block.content.trim().length > 0)).toBe(true);
  });

  it('keeps caller-provided punctuation unchanged instead of rewriting external instructions', () => {
    const original = '外部原文\uFF0C保留\u3002';
    const blocks = assemble({
      characterPrompt: () => [original],
      workspaceInstructions: original,
      memorySection: original,
      skillCatalog: original,
    });
    expect(blocks.filter(block => block.content.includes(original))).toHaveLength(4);
  });

  it('uses ASCII punctuation in all package-generated prompts', () => {
    const text = assemble({
      toolNames: [...Object.values(BuiltinTools).map(tool => tool.name), 'mcp__demo__search'],
    }).map(block => block.content).join('\n');
    const punctuation = text.match(/[\p{P}\p{S}]/gu) ?? [];
    expect(punctuation.filter(mark => mark.codePointAt(0)! > 127)).toEqual([]);
  });

  it('keeps product rules shared while dynamic model facts change', () => {
    const first = assemble();
    const second = assemble({
      environment: { ...input().environment, providerId: 'other', modelId: 'another-model' },
    });
    expect(first[0]).toBe(second[0]);
    expect(first.slice(0, -1)).toEqual(second.slice(0, -1));
    expect(second.at(-1)?.content).toContain('other / another-model');
  });

  it('keeps character paragraphs together with historical-speaker guidance', () => {
    const character = contentStartingWith(assemble(), CHARACTER[0]!);
    expect(character.startsWith(CHARACTER.join('\n\n'))).toBe(true);
    expect(character).toContain('## 历史发言角色');
    expect(character).toContain('不为身份未知的历史发言者猜测姓名');
    expect(character).toContain('不是要求你切换角色');
    const childText = assemble({ characterPrompt: undefined }).map(block => block.content).join('\n');
    expect(childText).not.toContain('## 历史发言角色');
    expect(childText).not.toContain('测试娘');
  });

  it('puts the actual working directory, project folders and model in the final block', () => {
    const environment = assemble({
      environment: {
        ...input().environment,
        cwd: 'D:/main',
        projectFolderPaths: ['D:/main', 'D:/other'],
      },
    }).at(-1)!.content;
    expect(environment).toContain('操作系统: win32');
    expect(environment).toContain('当前模型: openai / test-model');
    expect(environment).toContain('当前执行目录(cwd): D:/main');
    expect(environment).toContain('项目源文件夹:\n  - D:/main\n  - D:/other');
    const noDirectory = assemble({ environment: { ...input().environment, cwd: null } }).at(-1)!.content;
    expect(noDirectory).toContain('当前没有执行目录.');
    expect(noDirectory).not.toContain('项目源文件夹');
  });

  it('uses the supplied Memory guidance without adding another external-data warning to it', () => {
    const text = '使用 MemorySearch 按轨检索';
    const blocks = assemble({ memorySection: text });
    expect(blocks.some(block => block.content === text)).toBe(true);
    expect(staticSystemPrompt[0]!.content).toContain('外部内容信任级');
  });

  it.each([
    ['default', '默认权限', '默认权限不是只读限制'],
    ['acceptEdits', '自动接受编辑', '不因自动接受编辑而全面放行'],
    ['bypassPermissions', '绕过权限', '绕过权限不保证每次调用都被允许'],
    ['plan', 'Plan', '本轮只允许只读调查'],
  ] as const)('describes the actual permission mode: %s', (permissionMode, label, detail) => {
    const blocks = assemble({ permissionMode });
    const permissions = blocks.filter(block => block.content.startsWith('# 当前权限:'));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.content).toContain(`当前权限: ${label}`);
    expect(permissions[0]!.content).toContain(detail);
    expect(permissions[0]!.content).toContain('不自行切换权限');
    expect(permissions[0]!.cacheBreakpoint).toBeUndefined();
    expect(blocks[0]).toBe(staticSystemPrompt[0]);
  });

  it('places Plan constraints immediately after the character without changing the character', () => {
    const blocks = assemble({ permissionMode: 'plan' });
    const index = blocks.findIndex(block => block.content.startsWith(CHARACTER[0]!));
    expect(blocks[index + 1]!.content).toContain('当前权限: Plan');
    expect(blocks[index + 1]!.content).toContain('用回复交付结论');
    expect(blocks[index]!.content).toBe(contentStartingWith(assemble(), CHARACTER[0]!));
  });

  it('expands detailed tool guidance only for tools in the actual pool', () => {
    const guidance = contentStartingWith(assemble({
      toolNames: [
        BuiltinTools.FileRead.name,
        BuiltinTools.Glob.name,
        BuiltinTools.Grep.name,
        BuiltinTools.Bash.name,
        BuiltinTools.AskUser.name,
      ],
    }), '# 本轮能力引导');
    expect(guidance).toContain('读取文件使用 Read');
    expect(guidance).toContain('Grep 查询构造');
    expect(guidance).toContain('Glob 查询构造');
    expect(guidance).toContain('Bash 只用于构建, 测试, 包管理');
    expect(guidance).toContain('AskUser 用于取得业务信息或选择');
    expect(guidance).not.toContain('使用 Edit');
    expect(guidance).not.toContain('使用 Write');
    expect(guidance).not.toContain('Subagent');
  });

  it('keeps only generic capability text when the tool pool is empty', () => {
    const guidance = contentStartingWith(assemble({ toolNames: [] }), '# 本轮能力引导');
    expect(guidance).toBe('# 本轮能力引导\n\n若无特殊要求, 按常规流程处理.');
  });

  it('describes MCP tools by their names without a separate server-instructions input', () => {
    const guidance = contentStartingWith(assemble(), '# 本轮能力引导');
    expect(guidance).toContain('## MCP 工具');
    expect(guidance).toContain('mcp__');
    const withoutMcp = contentStartingWith(assemble({ toolNames: [BuiltinTools.Skill.name] }), '# 本轮能力引导');
    expect(withoutMcp).not.toContain('## MCP 工具');
  });

  it('distinguishes the current Turn checklist from persistent Tasks', () => {
    const guidance = contentStartingWith(assemble({
      toolNames: [
        BuiltinTools.TodoWrite.name,
        BuiltinTools.TaskCreate.name,
        BuiltinTools.TaskGet.name,
        BuiltinTools.TaskList.name,
        BuiltinTools.TaskUpdate.name,
      ],
    }), '# 本轮能力引导');
    expect(guidance).toContain(BuiltinTools.TodoWrite.name);
    expect(guidance).toContain(BuiltinTools.TaskCreate.name);
    expect(guidance).toContain('当前 Turn');
    expect(guidance).toContain('跨 Turn');
    expect(guidance).toContain('不要把每条 TODO 复制成持久 Task');
  });

  it('describes Markdown media links without treating an audio label as an audio format', () => {
    const text = staticSystemPrompt[0]!.content;
    expect(text).toContain('![简短说明](地址)');
    expect(text).toContain('地址不加尖括号');
    expect(text).toContain('绝对路径和正斜杠');
    expect(text).toContain('普通链接, 不伪造后缀');
    expect(text).toContain('[说明](地址)');
  });

  it('keeps character identity separate from the product name and discourages roleplay meta-narration', () => {
    const text = staticSystemPrompt[0]!.content;
    expect(text).toContain('EmaAgent 是产品与运行环境的名称');
    expect(text).not.toContain('你是 Ema');
    expect(text).toContain('角色指令与产品规则同为需要遵守的指令');
    expect(text).toContain('你从一开始就是该角色');
    expect(contentStartingWith(assemble(), CHARACTER[0]!)).toContain('测试娘');
  });

  it('preserves task, safety, verification and communication requirements', () => {
    const text = staticSystemPrompt[0]!.content;
    for (const rule of [
      '不要给出完成任务所需时间的估计或预测',
      '默认不写注释',
      '向第三方网页工具',
      '不要讲述内部机器如何运转',
      '一次回复最多提出一个最重要的问题',
      'Prompt Injection',
      '用户当前请求决定是聊天, 讨论, 调查还是执行',
      '用户分享情绪或日常经历时先回应表达本身',
      '聊天, 讨论技术, 研究和使用工具时都保持角色身份',
      '先确定可验收的结果',
      '类型检查不能代替运行验收',
      '不修改代码或外部状态',
      '隐私, 授权, 当前偏好和可能变化的事实不能只凭旧记忆决定',
      '说清已完成部分, 阻塞点和继续所需条件',
    ]) {
      expect(text).toContain(rule);
    }
  });
});
