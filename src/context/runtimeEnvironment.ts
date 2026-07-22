// 把本轮模型可见的工作区、平台、日期和模型身份冻结为运行时环境快照。

import type { RuntimeEnvironmentSnapshot } from './contextSnapshot.js';

export interface RuntimeEnvironmentBuildRequest {
  readonly providerId: string;
  readonly model: string;
  readonly workspaceRoot?: string | null;
  readonly now?: Date;
}

export function buildRuntimeEnvironmentSnapshot(
  request: RuntimeEnvironmentBuildRequest,
): RuntimeEnvironmentSnapshot {
  const now = request.now ?? new Date();
  return Object.freeze({
    currentDate: formatLocalDate(now),
    platform: process.platform,
    architecture: process.arch,
    workspaceRoot: request.workspaceRoot?.trim() || null,
    providerId: request.providerId,
    model: request.model,
  });
}

export function renderRuntimeEnvironment(
  snapshot: RuntimeEnvironmentSnapshot,
): string {
  const workspace = snapshot.workspaceRoot
    ? `- 当前工作区：${snapshot.workspaceRoot}`
    : '- 当前没有可操作的工作区。';

  return [
    '# 本轮运行环境',
    '',
    `- 当前日期：${snapshot.currentDate}`,
    `- 操作系统：${snapshot.platform} (${snapshot.architecture})`,
    `- 当前模型：${snapshot.providerId} / ${snapshot.model}`,
    workspace,
    '',
    '以上信息是本轮开始时冻结的运行时事实；文件、仓库和外部状态仍以工具的最新结果为准。',
  ].join('\n');
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
