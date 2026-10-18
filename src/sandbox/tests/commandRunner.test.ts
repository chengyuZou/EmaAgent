import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRunner } from '../command/commandRunner.js';
import { probeBash } from '../discovery/bashProbe.js';

describe('CommandRunner', () => {
  it('rejects an empty working directory', () => {
    expect(() => new CommandRunner({
      cwd: '',
      writablePaths: [],
      forbiddenPaths: [],
      networkAccess: 'none',
    }, { kind: 'native', path: '/bin/bash' })).toThrow('需要明确的 cwd');
  });

  it('executes a command after Bash discovery has completed', async context => {
    const probe = await probeBash();
    if (!probe.available || probe.source === 'wsl') {
      context.skip();
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-runner-'));
    try {
      const runner = new CommandRunner({
        cwd: root,
        writablePaths: [root],
        forbiddenPaths: [],
        networkAccess: 'none',
      }, { kind: 'native', path: probe.path });
      const result = await runner.start('echo sandbox-ok', { timeoutMs: 5_000 }).completion;
      expect(result.stdout).toContain('sandbox-ok');
      expect(result.exitCode).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
