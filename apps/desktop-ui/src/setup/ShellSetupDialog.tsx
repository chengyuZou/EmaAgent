import { useState } from 'react';
import { Button, Card } from '@ema-agent/ui';
import { shellApi } from '../api/shell.js';
import type { ShellStatus } from '../api/shell.js';
import { SidecarApiError } from '../api/sidecar-client.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/download/win';
const WSL_GUIDE_URL    = 'https://learn.microsoft.com/windows/wsl/install';

export interface ShellSetupDialogProps {
  status:     Extract<ShellStatus, { available: false }>;
  onResolved: () => void;
}

type Phase = 'idle' | 'installing' | 'done' | 'failed';

export function ShellSetupDialog({ status, onResolved }: ShellSetupDialogProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [log,   setLog]   = useState('');

  const handleInstall = async (): Promise<void> => {
    setPhase('installing');
    setLog('');
    try {
      const result = await shellApi.installGit();
      if (result.ok) {
        setPhase('done');
        setTimeout(onResolved, 1_500);
      } else {
        setLog(result.log.slice(0, 500));
        setPhase('failed');
      }
    } catch (err) {
      // B-064: 后端先经权限审批再安装。403=用户未批准; 409=已有安装在进行。
      if (err instanceof SidecarApiError && err.status === 403) {
        setLog('安装未获批准：请在权限确认弹窗中允许后重试。');
      } else if (err instanceof SidecarApiError && err.status === 409) {
        setLog('已有安装任务在进行中，请稍候。');
      } else {
        setLog(err instanceof Error ? err.message : String(err));
      }
      setPhase('failed');
    }
  };

  return (
    <div className="fixed inset-0 z-9998 flex items-center justify-center p-8" style={{ background: 'var(--ema-mask)' }}>
      <Card variant="elevated" padding="lg" className="max-w-md w-full">
        <div className="flex flex-col gap-4">

          <div className="text-base font-semibold" style={{ color: 'var(--ema-text-primary)' }}>
            需要 bash 才能使用 Agent 模式
          </div>

          <p className="text-sm leading-relaxed m-0" style={{ color: 'var(--ema-text-secondary)' }}>
            EmaAgent 的 Agent 模式通过 bash 执行工具命令。
            当前系统未检测到 bash(Git Bash / WSL)，请先安装。
          </p>

          {phase === 'installing' && (
            <p className="text-sm m-0" style={{ color: 'var(--ema-warning)' }}>
              正在安装 Git for Windows，请稍候(约 1-3 分钟)…
            </p>
          )}

          {phase === 'done' && (
            <p className="text-sm m-0" style={{ color: 'var(--ema-success)' }}>
              安装成功，正在重新检测环境…
            </p>
          )}

          {phase === 'failed' && (
            <div>
              <p className="text-sm m-0" style={{ color: 'var(--ema-danger)' }}>
                自动安装失败，请手动下载安装。
              </p>
              {log && (
                <pre className="text-[11px] mt-2 px-2 py-1.5 rounded overflow-x-auto max-h-24 whitespace-pre-wrap"
                     style={{ color: 'var(--ema-text-secondary)', background: 'var(--ema-bg)' }}>
                  {log}
                </pre>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {status.wingetAvailable && (phase === 'idle' || phase === 'failed') && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleInstall()}
              >
                {phase === 'failed' ? '重试 winget 安装' : '用 winget 安装 Git(推荐)'}
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => void tauriBridge.openUrl(GIT_DOWNLOAD_URL)}
            >
              手动下载 Git for Windows
            </Button>

            {status.wslAvailable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void tauriBridge.openUrl(WSL_GUIDE_URL)}
              >
                WSL2 安装指南(高级)
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={onResolved}
            >
              已安装，重新检测
            </Button>
          </div>

        </div>
      </Card>
    </div>
  );
}

const overlayStyle: React.CSSProperties = { display: 'none' };
