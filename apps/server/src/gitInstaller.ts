// 通过 winget 安装 Git for Windows,并在成功后强制重探 bash 可用性。
// 这是系统级副作用操作,归 LocalHost 的业务层;sandbox 只负责探测,不被安装动作反向写状态。

import { spawn } from 'node:child_process';
import { probeBash, resetBashProbeCache } from '@ema-agent/sandbox';

export interface GitInstallResult {
  ok: boolean;
  log: string;
}

/**
 * 通过 winget 安装 Git for Windows（静默，per-user 无需 UAC）。
 * 视下载速度约需 1-3 分钟。成功后清探测缓存并异步重探,
 * 下一次 probeBash()/probeBashSettled() 反映新状态。
 */
export function installGitViaWinget(): Promise<GitInstallResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      'winget',
      [
        'install', '--id', 'Git.Git',
        '-e', '--source', 'winget',
        '--scope', 'user',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ],
      { windowsHide: true },
    );

    const chunks: string[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, log: '安装超时（5 分钟），请手动下载安装。' });
    }, 300_000);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const ok = code === 0;
      if (ok) {
        // 不直接写探测缓存: 清掉后异步重探, 由 sandbox 自己重建事实。
        resetBashProbeCache();
        void probeBash({ fresh: true });
      }
      resolve({ ok, log: chunks.join('').trim() });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, log: err.message });
    });
  });
}
