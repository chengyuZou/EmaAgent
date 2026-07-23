// 这里运行经过沙箱包装的命令，并管理每个 Session 的沙箱配置和清理工作。

// TODO 文件名 manager.ts 不符 CLAUDE.md §14（Manager 不作兜底名）。主类是 CommandRunner，
//  文件该叫 commandRunner.ts。和 shell-probe 改名一起，等 C1 sandbox 批次统一改（import 涟漪）。
//
// TODO run() 的 background 分支 detached + unref + 立刻返回 exitCode:0，是假成功：
//  进程引用丢失、输出全丢、终态未知。这是评审 L803 点名的真实缺口，C1 批次修
//  （见 docs/sandbox-review.md）。修法：持有进程 + 写输出文件 + 返回 processId + exit 事件追踪。
//
// TODO run() 的 cwd 在 workspaceRoot 为空时回退 process.cwd()。子 Agent 传 workspaceRoot:''
//  时，若没传 cwd，会用 sidecar 的 process.cwd()，可能越出预期范围。待 C1 审查。
//
// TODO run() 的 background spawn 不处理 error 事件；若 executable 路径错会变 unhandled。
//  前台 spawnProcess 是否处理需确认 tools 包。待 C1 审查。
//
// TODO CommandRunner 持有 PermissionEngine 引用（refreshConfig 调 getRules）。方向对
//  （sandbox 服从 permission），但持有引用而非事件驱动，耦合偏紧。见 permission review。

import { existsSync, rmSync } from 'node:fs';
import { spawn }               from 'node:child_process';
import { spawnProcess }        from '@ema-agent/tools';
import type { PermissionEngine } from '@ema-agent/permission';
import type { SandboxBackend, SandboxConfig, RunOptions, RunResult } from './types.js';
import { detectBackend }           from './detect.js';
import { buildSandboxConfig }      from './config-builder.js';
import { AppLayerBackend }         from './backends/app-layer.js';
import { BubblewrapBackend }       from './backends/bubblewrap.js';
import { SandboxExecBackend }      from './backends/sandbox-exec.js';
import type { ConfigContext }      from './config-builder.js';
import { probeShell }            from './shell-probe.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS     = 600_000;

// ── CommandRunner ─────────────────────────────────────────────────────────────

export interface CommandRunnerOptions {
  workspaceRoot:  string;
  sessionId?:     string;
  /** Core 给出的私有路径，命令不得读取或修改。 */
  protectedPaths: readonly string[];
  /** V1 只有完全断网和全网访问两档。 */
  networkAccess: 'none' | 'full';
  /** 活的 PermissionEngine 实例；refreshConfig() 每次重读其规则。 */
  permission:     PermissionEngine;
}

/**
 * 每 Session 一个的 shell 执行引擎，带 OS 级沙箱。
 *
 * 生命周期（与软件 Session 一致）：
 *   new CommandRunner(opts) -> 初始化状态
 *   .run(cmd)               -> 包进沙箱、spawn、返回结果
 *   .cleanup()              -> 清除 bare-repo 攻击文件（每次工具执行后都调）
 *   .refreshConfig()        -> 用户增删 allow/deny 规则后重读 permission 规则
 *
 * Per-session 隔离：不要跨 Session 共享 CommandRunner。检测结果（哪个 backend
 * 可用）是模块级缓存；其余状态都在本实例内。
 */
export class CommandRunner {
  private readonly backend:    SandboxBackend;
  private config:              SandboxConfig;
  private scrubPaths:          string[];
  private readonly degradeReason: string | undefined;

  constructor(private readonly opts: CommandRunnerOptions) {
    const detection     = detectBackend();
    this.backend        = selectBackend(detection.backend);
    this.degradeReason  = detection.degradeReason;

    const built     = buildSandboxConfig(opts.permission.getRules(), this.configCtx());
    this.config     = built.config;
    this.scrubPaths = built.scrubPaths;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * 在沙箱内执行 shell 命令。
   * backend 为 AppLayerBackend 时无 OS 包装，直接 spawn。
   */
  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    const shell     = getShell();
    const cwd       = opts.cwd ?? (this.opts.workspaceRoot || process.cwd());
    const timeoutMs = Math.min(opts.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const { executable, args } = this.backend.wrap(command, shell, this.config);

    // TODO background 假成功，见文件顶部说明。C1 批次修。
    if (opts.background) {
      spawn(executable, args, { cwd, stdio: 'ignore', detached: true }).unref();
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }

    return spawnProcess(executable, args, cwd, timeoutMs, opts.signal);
  }

  /**
   * 删除上一次沙箱命令可能植入的 bare-repo 攻击文件。
   * 必须在每次工具执行后调用--不只是 bash--因为任何工具都可能间接 spawn shell。
   */
  cleanup(): void {
    for (const p of this.scrubPaths) {
      if (!existsSync(p)) continue;
      try {
        rmSync(p, { recursive: true });
      } catch (err) {
        // ENOENT：已被其他路径清理，无害。
        // permission error：可能意味着植入文件权限异常，记录但不中断清理流程。
        // 其他错误：记录，便于排查为何 bare-repo 防护失效。
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          // TODO 目前只记录到 stderr，C1 批次接结构化日志后改 emit 事件。
          console.warn(`[sandbox] cleanup 失败 (${code ?? 'unknown'}): ${p}`);
        }
      }
    }
  }

  /**
   * 从当前 permission 规则重新推导 SandboxConfig。
   * 在 PermissionEngine.addRule() / onRulePersisted 之后立即调用。
   */
  refreshConfig(): void {
    const built     = buildSandboxConfig(this.opts.permission.getRules(), this.configCtx());
    this.config     = built.config;
    this.scrubPaths = built.scrubPaths;
  }

  /**
   * 当沙箱降级到 app-layer、但本平台本应有 OS 沙箱时，返回人类可读原因。
   * 在 Session 启动时调一次，把原因暴露给用户。
   */
  getSandboxUnavailableReason(): string | undefined {
    return this.degradeReason;
  }

  /** 当前激活的 backend 名，诊断和测试用。 */
  get backendName(): string {
    return this.backend.name;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private configCtx(): ConfigContext {
    return {
      workspaceRoot: this.opts.workspaceRoot,
      sessionId:      this.opts.sessionId,
      protectedPaths: this.opts.protectedPaths,
      networkAccess:  this.opts.networkAccess,
    };
  }
}

// ── Backend selection ─────────────────────────────────────────────────────────

function selectBackend(kind: ReturnType<typeof detectBackend>['backend']): SandboxBackend {
  switch (kind) {
    case 'bubblewrap':   return new BubblewrapBackend();
    case 'sandbox-exec': return new SandboxExecBackend();
    default:             return new AppLayerBackend();
  }
}

// ── Shell selection ───────────────────────────────────────────────────────────

function getShell(): string {
  const result = probeShell();
  if (!result.available) {
    throw new Error(
      '[sandbox] bash 未找到，无法执行 shell 命令。' +
      '请安装 Git for Windows(https://git-scm.com/download/win)或启用 WSL2。',
    );
  }
  return result.path;
}