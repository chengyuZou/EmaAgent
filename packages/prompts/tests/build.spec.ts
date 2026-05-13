import { describe, it, expect } from 'vitest';
import { buildSystemBlock, buildSystemPrompt } from '../src/build.js';
import { buildModeBlock } from '../src/mode-blocks.js';
import type { CharacterCard } from '@ema-agent/character-card';
import type { CharacterCardId, TurnMode, AgentSubMode } from '@ema-agent/contracts';

// ── test fixtures ─────────────────────────────────────────────────────────────

function mockCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: 'test-card' as CharacterCardId,
    name: 'Test',
    version: 'v1.0.0',
    description: null,
    systemPrompt: 'You are a helpful test assistant.',
    speechPatterns: [],
    forbiddenTopics: [],
    emotionVocabulary: ['happy', 'sad', 'surprised'],
    motionVocabulary: ['wave', 'nod', 'shrug'],
    live2dModelId: null,
    isActive: true,
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ── buildModeBlock ────────────────────────────────────────────────────────────

describe('buildModeBlock', () => {
  it('returns chat-mode instructions', () => {
    const block = buildModeBlock('chat' as TurnMode);
    expect(block).toContain('日常对话（chat）');
    expect(block).toContain('保持角色人设');
    expect(block).toContain('不调用任何工具');
  });

  it('returns narrative-mode instructions', () => {
    const block = buildModeBlock('narrative' as TurnMode);
    expect(block).toContain('剧情叙事（narrative）');
    expect(block).toContain('沉浸式剧情交互');
    expect(block).toContain('不调用工具');
  });

  it('returns agent-mode instructions without sub-mode', () => {
    const block = buildModeBlock('agent' as TurnMode);
    expect(block).toContain('Agent 任务（agent）');
    expect(block).toContain('先理解任务再选工具');
    expect(block).not.toContain('子模式');
  });

  it('returns agent-mode with plan sub-mode instructions', () => {
    const block = buildModeBlock('agent' as TurnMode, {
      agentSubMode: 'plan' as AgentSubMode,
    });
    expect(block).toContain('子模式：plan');
    expect(block).toContain('生成执行计划');
    expect(block).toContain('等待用户确认后再行动');
  });

  it('returns agent-mode with debug sub-mode instructions', () => {
    const block = buildModeBlock('agent' as TurnMode, {
      agentSubMode: 'debug' as AgentSubMode,
    });
    expect(block).toContain('子模式：debug');
    expect(block).toContain('聚焦错误溯源');
  });

  it('returns agent-mode with full sub-mode instructions', () => {
    const block = buildModeBlock('agent' as TurnMode, {
      agentSubMode: 'full' as AgentSubMode,
    });
    expect(block).toContain('子模式：full');
    expect(block).toContain('全自动执行');
    expect(block).toContain('最小化用户确认次数');
  });

  it('includes workspace root list when provided', () => {
    const block = buildModeBlock('agent' as TurnMode, {
      workspaceRoots: ['/home/user/project', '/tmp/scratch'],
    });
    expect(block).toContain('当前允许操作的工作区目录：');
    expect(block).toContain('`/home/user/project`');
    expect(block).toContain('`/tmp/scratch`');
    expect(block).toContain('所有文件操作必须限定在以上目录范围内');
  });

  it('does not include workspace section when roots is empty', () => {
    const block = buildModeBlock('agent' as TurnMode, { workspaceRoots: [] });
    expect(block).not.toContain('当前允许操作的工作区目录');
  });
});

// ── buildSystemBlock ──────────────────────────────────────────────────────────

describe('buildSystemBlock', () => {
  it('starts with the card systemPrompt', () => {
    const card = mockCard({ systemPrompt: 'I am Ema, your assistant.' });
    const block = buildSystemBlock(card);
    expect(block.startsWith('I am Ema, your assistant.')).toBe(true);
  });

  it('contains the ACT protocol header', () => {
    const block = buildSystemBlock(mockCard());
    expect(block).toContain('## ACT 内联标签协议');
    expect(block).toContain('<|ACT:emotion:NAME|>');
    expect(block).toContain('<|ACT:motion:NAME|>');
    expect(block).toContain('<|DELAY:N|>');
  });

  it('lists emotion vocabulary from the card', () => {
    const card = mockCard({ emotionVocabulary: ['curious', 'shy'] });
    const block = buildSystemBlock(card);
    expect(block).toContain('`curious`');
    expect(block).toContain('`shy`');
  });

  it('lists motion vocabulary from the card', () => {
    const card = mockCard({ motionVocabulary: ['bow', 'point'] });
    const block = buildSystemBlock(card);
    expect(block).toContain('`bow`');
    expect(block).toContain('`point`');
  });

  it('includes ACT usage example', () => {
    const block = buildSystemBlock(mockCard());
    expect(block).toContain('<|ACT:emotion:surprised|>');
    expect(block).toContain('诶诶？！');
  });
});

// ── buildSystemPrompt ─────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('assembles character block + chat mode block', () => {
    const card = mockCard();
    const prompt = buildSystemPrompt(card, 'chat' as TurnMode);
    expect(prompt).toContain(card.systemPrompt);
    expect(prompt).toContain('## ACT 内联标签协议');
    expect(prompt).toContain('日常对话（chat）');
  });

  it('assembles character block + agent mode block', () => {
    const card = mockCard();
    const prompt = buildSystemPrompt(card, 'agent' as TurnMode, {
      agentSubMode: 'full' as AgentSubMode,
      workspaceRoots: ['/workspace'],
    });
    expect(prompt).toContain(card.systemPrompt);
    expect(prompt).toContain('Agent 任务（agent）');
    expect(prompt).toContain('子模式：full');
    expect(prompt).toContain('`/workspace`');
  });

  it('places character block before mode block', () => {
    const card = mockCard();
    const prompt = buildSystemPrompt(card, 'chat' as TurnMode);
    const charIndex = prompt.indexOf('## ACT 内联标签协议');
    const modeIndex = prompt.indexOf('日常对话（chat）');
    expect(charIndex).toBeLessThan(modeIndex);
  });
});
