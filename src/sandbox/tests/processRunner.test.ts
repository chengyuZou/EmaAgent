import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startProcess } from '../process/processRunner.js';
import { buildProcessEnvironment } from '../process/processEnvironment.js';
import { probeBash } from '../discovery/bashProbe.js';
import type { ProcessCommand } from '../types.js';

function makeCommand(executable: string, args: string[], cwd: string): ProcessCommand {
  return {
    executable,
    args,
    cwd,
    environment: buildProcessEnvironment(),
  };
}

async function bashOrSkip(): Promise<string | null> {
  const probe = await probeBash();
  // 无 bash 或 wsl 间接路径(终止语义不同)时跳过.
  if (!probe.available || probe.source === 'wsl') return null;
  return probe.path;
}

describe('startProcess 进程树终止', () => {
  it('已取消的 signal 直接返回, 不启动进程', async () => {
    const controller = new AbortController();
    controller.abort();
    // 可执行文件不存在: 若真的 spawn 会报 ENOENT, 预检应先返回取消结果.
    const result = await startProcess(
      makeCommand('definitely-not-exists.exe', [], os.tmpdir()),
      5_000,
      controller.signal,
    ).completion;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it('取消会终止整棵进程树, 不留孙进程', async () => {
    const shell = await bashOrSkip();
    if (shell === null) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-kill-'));
    const heartbeat = path.join(dir, 'hb.log').replace(/\\/g, '/');
    // bash 派生一个持续写心跳的孙进程; MSYS 的 $! 不是 Windows pid,
    // 所以用"心跳是否停止"这个跨平台可观察量判断孙进程死活.
    const script = `(while true; do echo x >> '${heartbeat}'; sleep 0.1; done) & wait`;
    const controller = new AbortController();
    const pending = startProcess(
      makeCommand(shell, ['-c', script], dir),
      60_000,
      controller.signal,
    ).completion;

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

    // 宽限后心跳必须停止: 孙进程真的死了, 不是"已发信号"就算完.
    await new Promise((r) => setTimeout(r, 600));
    const size1 = fs.statSync(heartbeat).size;
    await new Promise((r) => setTimeout(r, 400));
    const size2 = fs.statSync(heartbeat).size;
    expect(size2).toBe(size1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe('startProcess 输出与消费防线', () => {
  it('跨 chunk 拆分的多字节字符不碎', async () => {
    const shell = await bashOrSkip();
    if (shell === null) return;
    // "中" = E4 B8 AD: 先写前两字节, 隔 0.2s 再写第三字节:
    // 按块 toString 会解出两个 �, StringDecoder 应拼回完整字符.
    const result = await startProcess(
      makeCommand(shell, ['-c', `printf '\\xe4\\xb8'; sleep 0.2; printf '\\xad'`], os.tmpdir()),
      5_000,
    ).completion;
    expect(result.stdout).toBe('中');
  });

  it('原始输出保存失败时停止命令并报告失败', async () => {
    const shell = await bashOrSkip();
    if (shell === null) return;
    let calls = 0;
    const completion = startProcess(
      makeCommand(shell, ['-c', 'echo aaa; sleep 0.2; echo bbb'], os.tmpdir()),
      5_000,
      undefined,
      () => {
        calls += 1;
        throw new Error('消费方炸了');
      },
    ).completion;
    await expect(completion).rejects.toThrow('消费方炸了');
    expect(calls).toBe(1);
  });

  it('超上限输出被截断, 截断通知不破坏流预算', async () => {
    const shell = await bashOrSkip();
    if (shell === null) return;
    // ASCII 输出的字节数与 UTF-16 长度相同, 200,000 个字符超过单流预算.
    const result = await startProcess(
      makeCommand(shell, ['-c', 'yes 0123456789 | head -c 200000'], os.tmpdir()),
      15_000,
    ).completion;
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100_000);
    expect(result.stdout).toContain('输出已截断');
  }, 20_000);
});
