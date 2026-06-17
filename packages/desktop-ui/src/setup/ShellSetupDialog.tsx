import { useState } from 'react';
import { Button, Card } from '@ema-agent/ui';
import { shellApi } from '../api/shell.js';
import type { ShellStatus } from '../api/shell.js';
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
      setLog(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  return (
    <div style={overlayStyle}>
      <Card variant="elevated" padding="lg" className="max-w-md w-full">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div style={{ fontSize: 16, fontWeight: 600, color: '#f8f8f8' }}>
            需要 bash 才能使用 Agent 模式
          </div>

          <p style={{ fontSize: 13, color: '#a0a0b0', lineHeight: 1.6, margin: 0 }}>
            EmaAgent 的 Agent 模式通过 bash 执行工具命令。
            当前系统未检测到 bash（Git Bash / WSL），请先安装。
          </p>

          {phase === 'installing' && (
            <p style={{ fontSize: 13, color: '#f59e0b', margin: 0 }}>
              正在安装 Git for Windows，请稍候（约 1-3 分钟）…
            </p>
          )}

          {phase === 'done' && (
            <p style={{ fontSize: 13, color: '#22c55e', margin: 0 }}>
              安装成功，正在重新检测环境…
            </p>
          )}

          {phase === 'failed' && (
            <div>
              <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>
                自动安装失败，请手动下载安装。
              </p>
              {log && (
                <pre style={{
                  fontSize: 11, color: '#a0a0b0',
                  marginTop: 8, padding: '6px 8px',
                  background: 'rgba(0,0,0,0.3)', borderRadius: 4,
                  overflowX: 'auto', maxHeight: 100, whiteSpace: 'pre-wrap',
                }}>
                  {log}
                </pre>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {status.wingetAvailable && (phase === 'idle' || phase === 'failed') && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleInstall()}
              >
                {phase === 'failed' ? '重试 winget 安装' : '用 winget 安装 Git（推荐）'}
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
                使用 WSL2（高级）
              </Button>
            )}
          </div>

        </div>
      </Card>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position:       'fixed',
  inset:          0,
  zIndex:         9998,
  background:     'rgba(14, 12, 20, 0.93)',
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  padding:        32,
};
