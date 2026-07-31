// 测试 FileReadTool 保持模型结果不变，同时生成可信的读取范围展示数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { splitToolResult } from '@ema-agent/tools';
import type { BuiltinToolContext } from '../builtinToolContext.js';
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileReadTool Presentation', () => {
  it('按实际返回的行区间生成展示数据', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-file-read-presentation-'));
    tempDirs.push(directory);
    const target = path.join(directory, 'example.txt');
    fs.writeFileSync(target, '第一行\n第二行\n第三行', 'utf8');

    const hostContext: BuiltinToolContext = {
      sessionId: 'session-file-read' as BuiltinToolContext['sessionId'],
      turnId: 'turn-file-read' as BuiltinToolContext['turnId'],
      workspaceRoot: directory,
    platform: process.platform,
      readFileState: new Map(),
      signal: new AbortController().signal,
    };
    const projection = FileReadTool.unsafeValidateContext(hostContext);
    if (!projection.valid) throw new Error(projection.reason);

    const result = await FileReadTool.unsafeExecute(
      { file_path: target, offset: 2, limit: 1 },
      projection.context,
    );
    const split = splitToolResult(result);

    expect(split.modelOutput).toMatchObject({
      type: 'file_content',
      filePath: target,
      totalLines: 3,
      isPartialView: true,
    });
    expect(split.presentation).toEqual({
      kind: 'file_read',
      filePath: target,
      status: 'content',
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      partial: true,
      truncated: false,
    });
  });
});
