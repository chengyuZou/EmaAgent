import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../command/commandRunner.js';
import { resetDetectCache } from '../backends/detectBackend.js';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => boundary);
const directories: string[] = [];

beforeEach(() => {
  resetDetectCache();
  boundary.spawnSync.mockReturnValue({ status: 0, stdout: 'ema-sandbox-ok', stderr: '' });
  boundary.spawn.mockReset();
  boundary.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeRunner(bare: boolean): CommandRunner {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-command-paths-'));
  directories.push(root);
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'config'), 'project configuration');
  if (bare) {
    fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(root, 'objects'));
    fs.mkdirSync(path.join(root, 'refs'));
  }
  return new CommandRunner({
    cwd: root,
    writablePaths: [root],
    forbiddenPaths: [],
    networkAccess: 'none',
  }, { kind: 'native', path: '/bin/bash' });
}

describe('CommandRunner prepared execution', () => {
  it('starts immediately with a supplied Bash without starting another asynchronous probe', async () => {
    const runner = makeRunner(false);
    expect(boundary.spawn).not.toHaveBeenCalled();
    await expect(runner.start('echo ready').completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it('does not make ordinary project config and hooks read-only by their names', async () => {
    await makeRunner(false).start('echo ready').completion;
    const args = boundary.spawn.mock.calls[0]![1] as string[];
    const protection = args.join(' ');
    expect(protection).not.toContain('--ro-bind-try');
    expect(protection).not.toContain('(deny file-write*');
  });

  it('protects existing bare Git repository files when the complete directory signature exists', async () => {
    await makeRunner(true).start('echo ready').completion;
    const args = boundary.spawn.mock.calls[0]![1] as string[];
    const protection = args.join(' ');
    if (process.platform === 'darwin') {
      expect(protection).toContain('(deny file-write*');
    } else {
      expect(protection).toContain('--ro-bind-try');
    }
    expect(protection).toContain('/config');
    expect(protection).toContain('/hooks');
  });
});
