import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Callout, EntityRow, Spinner } from '@ema-agent/ui';
import type { McpLocalCommand } from '@ema-agent/mcp';
import { mcpApi, type McpEnvironmentResult } from '../../api/mcp.js';

const LABELS: Record<McpLocalCommand, string> = {
  npx: 'Node.js / npx',
  uvx: 'uv / uvx',
  bunx: 'Bun / bunx',
  python3: 'Python 3',
};

export function McpEnvironmentPage(): JSX.Element {
  const [result, setResult] = useState<McpEnvironmentResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const inspect = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await mcpApi.inspectEnvironment());
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void inspect(); }, [inspect]);
  const installedCount = result?.commands.filter(command => command.selectedPath !== null).length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">运行环境</h2>
          <p className="mt-0.5 text-xs text-[var(--ema-text-tertiary)]">检查 Node Server 实际用于启动 stdio MCP 的本机命令.</p>
        </div>
        <Button size="sm" variant="secondary" loading={checking} onClick={() => void inspect()}>
          <span className="i-mdi:refresh" aria-hidden />重新检查
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {checking && !result ? <div className="flex justify-center py-12"><Spinner size="md" /></div> : result && <>
        <div className="flex items-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
          <Badge variant="neutral">已安装 {installedCount}/{result.commands.length}</Badge>
          <span>候选路径按当前 Server 的 PATH 与系统扩展顺序排列.</span>
        </div>
        <div className="grid gap-3">
          {result.commands.map((inspection, index) => {
            const installed = inspection.selectedPath !== null;
            return <EntityRow key={inspection.command} index={index} decorate="ema-card-decorate--circuit" className="flex items-start gap-4 px-4 py-4">
              <span className="i-lucide:terminal-square mt-0.5 shrink-0 text-xl text-[var(--ema-primary)]" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm">{LABELS[inspection.command]}</strong>
                  <Badge variant="neutral">{inspection.command}</Badge>
                  <Badge variant={installed ? 'success' : 'danger'}>{installed ? '已安装' : '缺失'}</Badge>
                </div>
                {installed ? <>
                  <p className="mt-2 break-all text-xs text-[var(--ema-text-secondary)]">{inspection.selectedPath}</p>
                  {inspection.version && <p className="mt-1 text-xs text-[var(--ema-text-tertiary)]">版本: {inspection.version}</p>}
                  {inspection.candidatePaths.length > 1 && <details className="mt-2 text-xs text-[var(--ema-text-tertiary)]">
                    <summary className="cursor-pointer">其他候选路径 ({inspection.candidatePaths.length - 1})</summary>
                    <div className="mt-1 space-y-1 pl-3">{inspection.candidatePaths.slice(1).map(candidate => <p key={candidate} className="break-all">{candidate}</p>)}</div>
                  </details>}
                </> : <p className="mt-2 text-xs text-[var(--ema-text-tertiary)]">
                  未在当前 Server PATH 中发现 {inspection.command}.
                </p>}
              </div>
              {/* TODO: 找到稳定的跨平台方案后,重新设计运行环境安装业务. */}
            </EntityRow>;
          })}
        </div>
      </>}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
