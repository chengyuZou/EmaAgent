// Git 包全部可调参数,用 @ema-agent/settings 的 defineSetting 声明:
// schema 驱动校验 + 类型推导 + 注册进设置目录(UI 可查、将来可配、测试可覆盖)。
// 运行时默认取 DEFAULT_GIT_SETTINGS(单一事实源 = 各 setting 的 defaultValue);
// 要接用户配置时用 readGitSettings(store) 聚合读取快照。
//
// 超时分级:
//   readMs   只读查询(快,失败即报,claude 同款 5s)
//   writeMs  写操作(init/add/commit/apply,留足大目录 add -A)

import { defineSetting, type SettingsStore } from '@ema-agent/settings';
import { z } from 'zod';

// ── 声明 ─────────────────────────────────────────────────────────────────────

export const gitReadTimeoutMsSetting = defineSetting<number>({
  key: 'git.timeout.readMs',
  apply: 'nextOperation',
  defaultValue: 5_000,
  schema: z.number().int().min(1_000).max(120_000),
});

export const gitWriteTimeoutMsSetting = defineSetting<number>({
  key: 'git.timeout.writeMs',
  apply: 'nextOperation',
  defaultValue: 30_000,
  schema: z.number().int().min(5_000).max(600_000),
});

export const gitMaxOutputBytesSetting = defineSetting<number>({
  key: 'git.output.maxBytes',
  apply: 'nextOperation',
  defaultValue: 4 * 1024 * 1024,
  schema: z.number().int().min(64 * 1024).max(64 * 1024 * 1024),
});

export const gitDiffContextLinesSetting = defineSetting<number>({
  key: 'git.diff.contextLines',
  apply: 'nextOperation',
  defaultValue: 20,
  schema: z.number().int().min(1).max(100),
});

export const gitDiffMaxFileCharsSetting = defineSetting<number>({
  key: 'git.diff.maxFileChars',
  apply: 'nextOperation',
  defaultValue: 200_000,
  schema: z.number().int().min(1_000).max(4 * 1024 * 1024),
});

export const gitDiffMaxTotalCharsSetting = defineSetting<number>({
  key: 'git.diff.maxTotalChars',
  apply: 'nextOperation',
  defaultValue: 2_000_000,
  schema: z.number().int().min(10_000).max(64 * 1024 * 1024),
});

export const gitDiffMaxFilesPerScopeSetting = defineSetting<number>({
  key: 'git.diff.maxFilesPerScope',
  apply: 'nextOperation',
  defaultValue: 200,
  schema: z.number().int().min(10).max(2_000),
});

export const gitDiffMaxUntrackedFilesSetting = defineSetting<number>({
  key: 'git.diff.maxUntrackedFiles',
  apply: 'nextOperation',
  defaultValue: 50,
  schema: z.number().int().min(1).max(1_000),
});

export const gitDiffUntrackedConcurrencySetting = defineSetting<number>({
  key: 'git.diff.untrackedConcurrency',
  apply: 'nextOperation',
  defaultValue: 8,
  schema: z.number().int().min(1).max(32),
});

export const gitDiffProcessOutputBytesSetting = defineSetting<number>({
  key: 'git.diff.processOutputBytes',
  apply: 'nextOperation',
  defaultValue: 8 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
});

export const gitBaselineMaxDiffBytesSetting = defineSetting<number>({
  key: 'git.baseline.maxDiffBytes',
  apply: 'nextOperation',
  defaultValue: 4 * 1024 * 1024,
  schema: z.number().int().min(64 * 1024).max(64 * 1024 * 1024),
});

export const gitBaselineMaxChangesForUnifiedSetting = defineSetting<number>({
  key: 'git.baseline.maxChangesForUnified',
  apply: 'nextOperation',
  defaultValue: 200,
  schema: z.number().int().min(10).max(2_000),
});

// ── 快照类型与默认 ──────────────────────────────────────────────────────────

export interface GitSettings {
  readTimeoutMs: number;
  writeTimeoutMs: number;
  maxOutputBytes: number;
  diffContextLines: number;
  maxFileDiffChars: number;
  maxTotalDiffChars: number;
  maxFilesPerScope: number;
  maxUntrackedFiles: number;
  untrackedDiffConcurrency: number;
  diffProcessOutputBytes: number;
  baselineMaxDiffBytes: number;
  baselineMaxChangesForUnified: number;
}

/** 运行时默认快照;单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_GIT_SETTINGS: GitSettings = {
  readTimeoutMs: gitReadTimeoutMsSetting.defaultValue,
  writeTimeoutMs: gitWriteTimeoutMsSetting.defaultValue,
  maxOutputBytes: gitMaxOutputBytesSetting.defaultValue,
  diffContextLines: gitDiffContextLinesSetting.defaultValue,
  maxFileDiffChars: gitDiffMaxFileCharsSetting.defaultValue,
  maxTotalDiffChars: gitDiffMaxTotalCharsSetting.defaultValue,
  maxFilesPerScope: gitDiffMaxFilesPerScopeSetting.defaultValue,
  maxUntrackedFiles: gitDiffMaxUntrackedFilesSetting.defaultValue,
  untrackedDiffConcurrency: gitDiffUntrackedConcurrencySetting.defaultValue,
  diffProcessOutputBytes: gitDiffProcessOutputBytesSetting.defaultValue,
  baselineMaxDiffBytes: gitBaselineMaxDiffBytesSetting.defaultValue,
  baselineMaxChangesForUnified: gitBaselineMaxChangesForUnifiedSetting.defaultValue,
};

/** 聚合读取 git 设置快照(坏值/缺失自动回落默认)。 */
export function readGitSettings(store: SettingsStore): GitSettings {
  return {
    readTimeoutMs: store.get(gitReadTimeoutMsSetting),
    writeTimeoutMs: store.get(gitWriteTimeoutMsSetting),
    maxOutputBytes: store.get(gitMaxOutputBytesSetting),
    diffContextLines: store.get(gitDiffContextLinesSetting),
    maxFileDiffChars: store.get(gitDiffMaxFileCharsSetting),
    maxTotalDiffChars: store.get(gitDiffMaxTotalCharsSetting),
    maxFilesPerScope: store.get(gitDiffMaxFilesPerScopeSetting),
    maxUntrackedFiles: store.get(gitDiffMaxUntrackedFilesSetting),
    untrackedDiffConcurrency: store.get(gitDiffUntrackedConcurrencySetting),
    diffProcessOutputBytes: store.get(gitDiffProcessOutputBytesSetting),
    baselineMaxDiffBytes: store.get(gitBaselineMaxDiffBytesSetting),
    baselineMaxChangesForUnified: store.get(gitBaselineMaxChangesForUnifiedSetting),
  };
}

