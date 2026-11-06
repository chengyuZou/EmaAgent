import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { McpLocalCommandEnvironment } from '../localCommandEnvironment.js';

let directory: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('Python 候选各启动一次, 跳过 Python 2; 其他命令探测失败仍保留路径', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-mcp-env-'));
  const writeCommand = (name: string, version: string, exitCode: number): string => {
    const counter = path.join(directory!, `${name}.calls`);
    const executable = path.join(directory!, process.platform === 'win32' ? `${name}.cmd` : name);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const script = process.platform === 'win32'
      ? `@echo off\r\n>>"${counter}" echo called\r\necho ${version}\r\nexit /b ${exitCode}\r\n`
      : `#!/bin/sh\nprintf 'called\\n' >> ${quote(counter)}\nprintf '%s\\n' ${quote(version)}\nexit ${exitCode}\n`;
    fs.writeFileSync(executable, script, { mode: 0o700 });
    return executable;
  };
  const python2 = writeCommand('python3', 'Python 2.7.18', 0);
  const python3 = writeCommand('python', 'Python 3.12.0', 0);
  const npx = writeCommand('npx', 'version unavailable', 1);
  vi.stubEnv('PATH', directory);
  if (process.platform === 'win32') vi.stubEnv('PATHEXT', '.CMD');

  const result = await new McpLocalCommandEnvironment().inspect();
  expect(result.find(item => item.command === 'python3')).toEqual({
    command: 'python3', selectedPath: python3, candidatePaths: [python2, python3], version: 'Python 3.12.0',
  });
  expect(result.find(item => item.command === 'npx')).toMatchObject({ selectedPath: npx, version: null });
  expect(result.find(item => item.command === 'uvx')).toMatchObject({ selectedPath: null, candidatePaths: [], version: null });
  for (const name of ['python3', 'python', 'npx']) {
    expect(fs.readFileSync(path.join(directory, `${name}.calls`), 'utf8').trim()).toBe('called');
  }
}, 15_000);
