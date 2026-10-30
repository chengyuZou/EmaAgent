import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildKeywordExtractionPrompt, ROUTER_PROMPT } from '../pipeline/prompts.js';

it('提词正文与保存的 LightRAG v1.5.7 模板逐字一致, 只填入语言, 格式和 Query', () => {
  // 对照文件取自 LightRAG v1.5.7 的 prompt.py, 不从本包提词生成.
  // 固定提交: 28ff1b05f2ac3f3e6fa14dd2cd33656579bd0c9c.
  const { template, examples } = JSON.parse(readFileSync(
    new URL('./fixtures/lightragKeywords.json', import.meta.url), 'utf8',
  )) as { template: string; examples: string };
  const query = '第二周目安安落地后被谁杀死?';
  const expected = template
    .replaceAll('{{', '{')
    .replaceAll('}}', '}')
    .replace('{language}', 'English')
    .replace('{examples}', examples)
    .replace('{query}', query);
  expect(buildKeywordExtractionPrompt(query)).toBe(expected);
});

it('Query 内的花括号和模板名称保持原样, 不二次替换', () => {
  const query = '请查 {query}, {language}, {examples}, {{原文}} 和 $& 的含义.';
  const prompt = buildKeywordExtractionPrompt(query);
  expect(prompt).toContain(`User Query: ${query}\n\n---Output---`);
  expect(prompt).not.toContain('剧情摘要');
});

it('周目 Prompt 只要求 timelines 数组, 不含旧的子问题或提词任务', () => {
  expect(ROUTER_PROMPT).toContain('## 剧情摘要');
  expect(ROUTER_PROMPT).toContain('仅包含 timelines 字段');
  expect(ROUTER_PROMPT).not.toContain('## 子问题要求');
  expect(ROUTER_PROMPT).not.toContain('## 子问题提词');
  expect(ROUTER_PROMPT).not.toContain('high_level_keywords');
  expect(ROUTER_PROMPT).not.toContain('low_level_keywords');
});
