// 进程树终止测试: 孙进程不能逃逸取消; 已取消 signal 不启动进程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../processRunner.js';
import { buildProcessEnvironment } from '../processEnvironment.js';
import { probeBash } from '../bashProbe.js';
import type { SandboxCommand } from '../types.js';

function makeCommand(executable: string, args: string[], cwd: string): SandboxCommand {
  return {
    backend: 'app-layer',
    executable,
    args,
    cwd,
    environment: buildProcessEnvironment(),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess 进程树终止', () => {
  it('已取消的 signal 直接返回, 不启动进程', async () => {
    const controller = new AbortController();
    controller.abort();
    // 可执行文件不存在: 若真的 spawn 会报 ENOENT, 预检应先返回取消结果。
    const result = await runProcess(
      makeCommand('definitely-not-exists.exe', [], os.tmpdir()),
      5_000,
      controller.signal,
    );
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it('取消会终止整棵进程树, 不留孙进程', async () => {
    const shell = probeBash();
    if (!shell.available || shell.path === 'wsl:bash') {
      // 无 bash 的环境跳过(wsl 间接路径的终止语义另测)。
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-kill-'));
    const heartbeat = path.join(dir, 'hb.log').replace(/\\/g, '/');
    // bash 派生一个持续写心跳的孙进程; MSYS 的 $! 不是 Windows pid,
    // 所以用"心跳是否停止"这个跨平台可观察量判断孙进程死活。
    const script = `(while true; do echo x >> '${heartbeat}'; sleep 0.1; done) & wait`;
    const controller = new AbortController();
    const pending = runProcess(
      makeCommand(shell.path, ['-c', script], dir),
      60_000,
      controller.signal,
    );

    // 等心跳文件开始增长
    let size0 = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (fs.existsSync(heartbeat)) size0 = fs.statSync(heartbeat).size;
      if (size0 > 2) break;
    }
    expect(size0).toBeGreaterThan(2);

    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);

    // 宽限后心跳必须停止: 孙进程真的死了, 不是"已发信号"就算完。
    await new Promise((r) => setTimeout(r, 600));
    const size1 = fs.statSync(heartbeat).size;
    await new Promise((r) => setTimeout(r, 400));
    const size2 = fs.statSync(heartbeat).size;
    expect(size2).toBe(size1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
