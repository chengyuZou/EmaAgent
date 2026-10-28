import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkToolPermission } from '../checkToolPermission.js';
import { clearSessionApprovals, rememberSessionApproval } from '../rules/sessionApprovals.js';
import type { PermissionContext, PermissionDecision, ToolPermissionCheck } from '../types.js';

const sessionId = 'permission-test';
const directories: string[] = [];
const context = (mode: PermissionContext['mode'] = 'default'): PermissionContext =>
  ({ sessionId, mode, rules: [], workspaceRoots: [] });
const rule = (toolName: string, decision: PermissionDecision, condition?: string) =>
  ({ key: { toolName, condition }, decision, from: 'userSettings' as const });
const tool = (name: string, check: ToolPermissionCheck) =>
  ({ name, checkPermissions: vi.fn(async () => check) });
const check = (name: string, data: ToolPermissionCheck, ctx = context(), input: unknown = {}) =>
  checkToolPermission(tool(name, data), input, undefined, ctx, { interactive: true });
const ordinary: ToolPermissionCheck = { kind: 'tool', defaultDecision: 'ask' };

function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-permission-'));
  directories.push(result);
  return result;
}

afterEach(() => {
  clearSessionApprovals(sessionId);
  clearSessionApprovals('other-session');
  vi.restoreAllMocks();
  for (const entry of directories.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

describe('统一权限入口', () => {
  it('整个工具被禁止时, 不调用工具的权限信息入口', async () => {
    const target = tool('Read', ordinary);
    const result = await checkToolPermission(target, {}, undefined, {
      ...context('bypassPermissions'), rules: [rule('Read', 'deny')],
    }, { interactive: true });
    expect(result.decision).toBe('deny');
    expect(target.checkPermissions).not.toHaveBeenCalled();
  });

  it('Permission 内部调用 checkPermissions, 不把规则交给工具', async () => {
    const target = tool('Probe', ordinary);
    await checkToolPermission(target, { x: 1 }, { cwd: 'test' }, context(), { interactive: true });
    expect(target.checkPermissions).toHaveBeenCalledOnce();
    expect(target.checkPermissions).toHaveBeenCalledWith({ x: 1 }, { cwd: 'test' });
  });

  it('未声明会话批准范围时不自动生成, 没有交互入口时返回拒绝', async () => {
    expect(await check('Probe', ordinary)).toEqual({
      decision: 'ask', message: '允许执行 Probe 吗?',
    });
    expect((await checkToolPermission(tool('Probe', ordinary), {}, undefined, context(),
      { interactive: false })).decision).toBe('deny');
  });

  it('默认允许仍受拒绝和询问规则约束, 默认询问可由 bypass 放行', async () => {
    const read: ToolPermissionCheck = { kind: 'tool', defaultDecision: 'allow' };
    expect((await check('Read', read)).decision).toBe('allow');
    expect((await check('Read', read, { ...context(), rules: [rule('Read', 'ask')] })).decision).toBe('ask');
    expect((await check('Probe', ordinary, context('bypassPermissions'))).decision).toBe('allow');
    expect((await check('Probe', ordinary, {
      ...context('bypassPermissions'), rules: [rule('Probe', 'ask')],
    })).decision).toBe('ask');
  });

  it('只含工具名的 Session 批准生效, 同一上下文立即读到新增批准', async () => {
    const ctx = { ...context(), rules: [rule('Probe', 'ask')] };
    expect((await check('Probe', ordinary, ctx)).decision).toBe('ask');
    rememberSessionApproval(sessionId, { toolName: 'Probe' });
    expect((await check('Probe', ordinary, ctx)).decision).toBe('allow');
    expect((await check('Other', ordinary, ctx)).decision).toBe('ask');
    expect((await check('Probe', ordinary, { ...ctx, sessionId: 'other-session' })).decision).toBe('ask');
    expect((await check('Probe', ordinary, { ...ctx, rules: [rule('Probe', 'deny')] })).decision).toBe('deny');
    clearSessionApprovals(sessionId);
    expect((await check('Probe', ordinary, ctx)).decision).toBe('ask');
  });

  it('明确选择完整输入批准时忽略对象键顺序, 不忽略数组顺序或参数值', async () => {
    const data: ToolPermissionCheck = { kind: 'tool', defaultDecision: 'ask', sessionApproval: 'input' };
    const first = await check('Probe', data, context(), { list: [1, 2], object: { b: 2, a: 1 } });
    if (first.decision !== 'ask' || !first.sessionApproval) throw new Error('expected approval');
    rememberSessionApproval(sessionId, first.sessionApproval.key);
    expect((await check('Probe', data, context(), { object: { a: 1, b: 2 }, list: [1, 2] })).decision).toBe('allow');
    expect((await check('Probe', data, context(), { object: { a: 1, b: 2 }, list: [2, 1] })).decision).toBe('ask');
  });
});

describe('文件和命令检查', () => {
  it('普通写入在默认模式询问, acceptEdits 仅放行工作区, bypass 放行普通写入', async () => {
    const root = directory();
    const write = { kind: 'file', operation: 'write', target: 'file', path: path.join(root, 'a.txt') } as const;
    expect((await check('Write', write)).decision).toBe('ask');
    expect((await check('Write', write, context('bypassPermissions'))).decision).toBe('allow');
    expect((await check('Write', write, context('acceptEdits'))).decision).toBe('ask');
    expect((await check('Write', write, { ...context('acceptEdits'), workspaceRoots: [root] })).decision).toBe('allow');
    expect((await check('Write', write, {
      ...context('bypassPermissions'), rules: [rule('Write', 'ask')],
    })).decision).toBe('ask');
  });

  it('敏感写入仍需确认, 明确批准文件后可复用, 拒绝优先于批准', async () => {
    const root = directory();
    const write = { kind: 'file', operation: 'write', target: 'file', path: path.join(root, '.env') } as const;
    const first = await check('Write', write, context('bypassPermissions'));
    if (first.decision !== 'ask' || !first.sessionApproval) throw new Error('expected approval');
    rememberSessionApproval(sessionId, first.sessionApproval.key);
    expect((await check('Write', write)).decision).toBe('allow');
    expect((await check('Write', write, {
      ...context(), rules: [rule('Write', 'deny', first.sessionApproval.key.condition)],
    })).decision).toBe('deny');
  });

  it('工作区读取和内部下载读取放行, 真实路径越出内部目录仍需确认', async () => {
    const root = directory();
    const outside = directory();
    fs.mkdirSync(path.join(root, 'downloads'));
    fs.writeFileSync(path.join(outside, 'a.txt'), 'fixture');
    fs.symlinkSync(outside, path.join(root, 'downloads', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const read = {
      kind: 'file', operation: 'read', target: 'file',
      path: path.join(root, 'downloads', 'a.txt'), internalReadDirectories: [path.join(root, 'downloads')],
    } as const;
    expect((await check('Read', read)).decision).toBe('allow');
    expect((await check('Read', { ...read, path: path.join(root, 'downloads', 'link', 'a.txt') })).decision).toBe('ask');
    expect((await check('Read', { ...read, internalReadDirectories: undefined }, {
      ...context(), workspaceRoots: [root],
    })).decision).toBe('allow');
  });

  it('网络目标批准前不查文件系统, 不能为判断目录而连接远端', async () => {
    const stat = vi.spyOn(fs, 'statSync');
    const realpath = vi.spyOn(fs, 'realpathSync');
    const result = await check('Grep', {
      kind: 'file', operation: 'read', target: 'path', path: '//server/share/file',
    }, context(), { path: '//server/share/file', pattern: 'x' });
    expect(result.decision).toBe('ask');
    expect(stat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it('命令允许规则须覆盖全部子命令, 拒绝只需命中其中一条', async () => {
    const command = { kind: 'shell', command: 'git status && pnpm test', subcommands: ['git status', 'pnpm test'], canMatchSubcommands: true } as const;
    const ctx = { ...context(), rules: [rule('Bash', 'allow', 'git:*')] };
    expect((await check('Bash', command, ctx)).decision).toBe('ask');
    ctx.rules.push(rule('Bash', 'allow', 'pnpm:*'));
    expect((await check('Bash', command, ctx)).decision).toBe('allow');
    ctx.rules.push(rule('Bash', 'deny', 'pnpm:*'));
    expect((await check('Bash', command, ctx)).decision).toBe('deny');
  });

  it('不可靠解析不能借子命令放行, 完整命令批准仍可复用', async () => {
    const command = { kind: 'shell', command: 'echo *', subcommands: ['echo'], canMatchSubcommands: false } as const;
    expect((await check('Bash', command, {
      ...context(), rules: [rule('Bash', 'allow', 'echo:*')],
    })).decision).toBe('ask');
    const first = await check('Bash', command);
    if (first.decision !== 'ask' || !first.sessionApproval) throw new Error('expected approval');
    rememberSessionApproval(sessionId, first.sessionApproval.key);
    expect((await check('Bash', command)).decision).toBe('allow');
    expect((await check('Bash', { ...command, command: 'echo other' })).decision).toBe('ask');
  });
});

describe('网页, MCP 和电脑操控', () => {
  it('网页预批准仍受用户询问和拒绝规则限制', async () => {
    const fetch = { kind: 'webFetch', url: 'https://docs.python.org/3/' } as const;
    expect((await check('WebFetch', fetch)).decision).toBe('allow');
    expect((await check('WebFetch', fetch, { ...context(), rules: [rule('WebFetch', 'ask', 'domain:docs.python.org')] })).decision).toBe('ask');
    expect((await check('WebFetch', fetch, { ...context(), rules: [rule('WebFetch', 'deny')] })).decision).toBe('deny');
  });

  it('MCP 破坏性提示必须确认, 普通调用可按 bypass 放行', async () => {
    expect((await check('MCP', { kind: 'mcp', reportedDestructive: true }, context('bypassPermissions'))).decision).toBe('ask');
    expect((await check('MCP', { kind: 'mcp', reportedDestructive: false }, context('bypassPermissions'))).decision).toBe('allow');
  });

  it('电脑启动只批准当前操控, 即使有整工具 Session 批准也重新确认', async () => {
    rememberSessionApproval(sessionId, { toolName: 'ObserveWindow' });
    const first = await check('ObserveWindow', { kind: 'computerUse', needsStartupApproval: true }, context('bypassPermissions'));
    expect(first.decision).toBe('ask');
    expect(first).not.toHaveProperty('sessionApproval');
    const active = { kind: 'computerUse', needsStartupApproval: false } as const;
    expect((await check('ObserveWindow', active, {
      ...context(), rules: [rule('ObserveWindow', 'ask')],
    })).decision).toBe('allow');
    expect((await check('ObserveWindow', active, {
      ...context(), rules: [rule('ObserveWindow', 'deny')],
    })).decision).toBe('deny');
  });
});
