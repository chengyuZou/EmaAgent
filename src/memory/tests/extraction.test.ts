// 验证两轨提取只消费 Memory 自有的 Turn 事实，并共享空结果语义。

import type { Message } from '@ema-agent/llm';
import { describe, expect, it } from 'vitest';
import type { MemoryTurnMessage } from '../common/extraction.js';
import {
  MEMORY_EXTRACTION_NO_RESULT,
  runTurnExtraction,
} from '../common/extraction.js';
import { buildWorkExtractionInput, serializeWorkTurn } from '../work/extraction.js';
import {
  buildRelationshipExtractionInput,
  serializeRelationshipTurn,
} from '../relationship/extraction.js';

const TURN_MESSAGES: readonly MemoryTurnMessage[] = [
  { kind: 'user_message', text: '修构建' },
  {
    kind: 'tool_call',
    toolCallId: 'c1',
    toolName: 'Bash',
    input: '{"command":"pnpm build"}',
  },
  { kind: 'tool_result', toolCallId: 'c1', content: 'ok', isError: false },
  { kind: 'user_decision', prompt: '要继续吗？', answer: '继续' },
  { kind: 'assistant_message', text: '完成' },
];

describe('Work 提取输入', () => {
  it('保留整个 Turn 的对话、用户决定和工具证据', () => {
    expect(buildWorkExtractionInput(TURN_MESSAGES, 'D:\\repo')).toEqual({
      workspaceRoot: 'D:\\repo',
      messages: TURN_MESSAGES,
    });
  });

  it('序列化保留工作区身份', () => {
    expect(serializeWorkTurn({
      workspaceRoot: 'D:\\repo',
      messages: [{ kind: 'user_message', text: 'hi' }],
    })).toContain('"workspaceRoot": "D:\\\\repo"');
  });
});

describe('Relationship 提取输入', () => {
  it('保留对话和用户明确决定，过滤其他工具过程', () => {
    expect(buildRelationshipExtractionInput(TURN_MESSAGES, 'ema')).toEqual({
      characterDirectoryName: 'ema',
      messages: [
        { kind: 'user_message', text: '修构建' },
        { kind: 'user_decision', prompt: '要继续吗？', answer: '继续' },
        { kind: 'assistant_message', text: '完成' },
      ],
    });
  });

  it('序列化保留角色目录归属', () => {
    expect(serializeRelationshipTurn({
      characterDirectoryName: 'ema',
      messages: [{ kind: 'user_message', text: '你好' }],
    })).toContain('"characterDirectoryName": "ema"');
  });
});

describe('提取结果协议', () => {
  it('固定 system + user 两段消息，并清理有用输出', async () => {
    let received: readonly Message[] = [];
    const result = await runTurnExtraction(
      '系统规则',
      '提取工作记忆',
      'turn facts',
      async (messages) => {
        received = messages;
        return '  - 偏好 pnpm  ';
      },
    );

    expect(received[0]).toEqual({ role: 'system', content: '系统规则' });
    expect(received[1]?.role).toBe('user');
    expect(result).toBe('- 偏好 pnpm');
  });

  it('把 NO_MEMORY 归一为无提取结果', async () => {
    const result = await runTurnExtraction(
      'a',
      'b',
      'c',
      async () => MEMORY_EXTRACTION_NO_RESULT,
    );
    expect(result).toBeUndefined();
  });
});
