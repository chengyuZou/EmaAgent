// 这里构造给 LLM 的视觉提取 prompt(按 5 种任务给不同指令)和按任务的 token 上限。

import type { VisionTask } from './types.js';

const TASK_INSTRUCTIONS: Record<VisionTask, string> = {
  auto:
    'Extract the useful visible information. Prefer OCR text when readable text exists; otherwise provide a concise visual description.',
  caption:
    'Describe the visible scene, objects, UI state, and relevant details. Keep it factual.',
  ocr:
    'Extract all readable text in natural reading order. Preserve important line breaks.',
  layout:
    'Extract text and describe layout regions, headings, tables, figures, and visual hierarchy.',
  table:
    'Focus on tables. Reconstruct each table as markdown when possible.',
};

export interface BuildVisionExtractionPromptArgs {
  task: VisionTask;
  language?: string;
  imageCount: number;
  customInstruction?: string;
}

export function buildVisionExtractionPrompt(args: BuildVisionExtractionPromptArgs): string {
  const languageLine = args.language
    ? `Preferred output language: ${args.language}.`
    : 'Use the source language when extracting text; use concise English for neutral labels when needed.';

  const custom = args.customInstruction?.trim()
    ? `\nAdditional caller instruction:\n${args.customInstruction.trim()}\n`
    : '';

  return [
    'You are EmaAgent Vision, a visual extraction component.',
    'Return only valid JSON. Do not wrap it in markdown fences.',
    '',
    `Task: ${args.task}`,
    `Images: ${args.imageCount}`,
    TASK_INSTRUCTIONS[args.task],
    languageLine,
    custom.trim(),
    '',
    'JSON schema:',
    '{',
    '  "text": "plain text extraction or concise visual description",',
    '  "markdown": "optional markdown representation for documents or tables",',
    '  "blocks": [',
    '    {',
    '      "id": "stable block id such as block-1",',
    '      "kind": "text | table | image | layout | formula | caption",',
    '      "text": "block text",',
    '      "markdown": "optional markdown for this block",',
    '      "bbox": [0.0, 0.0, 1.0, 1.0],',
    '      "confidence": 0.0',
    '    }',
    '  ],',
    '  "warnings": ["optional warnings when text is unclear or layout is uncertain"]',
    '}',
    '',
    'Rules:',
    '- Do not invent text that is not visible.',
    '- Use normalized bbox coordinates when layout can be estimated; omit bbox otherwise.',
    '- Preserve table cell structure in markdown when possible.',
    '- If no readable text exists, set "text" to a concise visual caption.',
  ].filter((line) => line.length > 0).join('\n');
}

export function defaultMaxTokensForVisionTask(task: VisionTask): number {
  switch (task) {
    case 'auto':
      return 2048;
    case 'caption':
      return 1024;
    case 'ocr':
      return 2048;
    case 'layout':
    case 'table':
      return 4096;
  }
}
