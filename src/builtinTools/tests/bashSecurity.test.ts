// Bash 静态安全分析链测试: 硬拦/确认/放行三档、重定向越界、wrapper 剥离、
// sed 后门、复合攻击、只读证明、破坏性警告与退出码语义。

import { describe, expect, it } from 'vitest';
import {
  analyzeBashCommand,
  splitCommandSegments,
  stripWrappers,
} from '../tools/BashTool/bashSecurity.js';
import { interpretExitCode } from '../tools/BashTool/commandSemantics.js';
import { BashTool } from '../tools/BashTool/BashTool.js';

function kind(command: string): string {
  return analyzeBashCommand(command).kind;
}

describe('analyzeBashCommand — 硬拦(deny)', () => {
  it('不可逆系统损害模式', () => {
    expect(kind(':(){ :|:& };:')).toBe('deny');
    expect(kind('mkfs /dev/sda1')).toBe('deny');
    expect(kind('dd if=/dev/zero of=/dev/sda')).toBe('deny');
  });

  it('rm 递归强制: 危险目标硬拦, 工作区相对路径放行', () => {
    expect(kind('rm -rf /')).toBe('deny');
    expect(kind('rm -rf "/"')).toBe('deny');
    expect(kind('rm -rf ~')).toBe('deny');
    expect(kind('rm -rf /etc/cache')).toBe('deny');
    expect(kind('rm -rf /tmp/cache')).toBe('ok');
    expect(kind('rm -rf ./node_modules')).toBe('ok');
    expect(kind('rm -rf build')).toBe('ok');
    expect(kind('rm file.txt')).toBe('ok');
  });

  it('wrapper 剥离后再判定: FOO=bar 不能掩护 rm -rf /', () => {
    expect(kind('FOO=bar rm -rf /')).toBe('deny');
    expect(kind('timeout 10 rm -rf /')).toBe('deny');
  });

  it('重定向越界: 只允许相对路径、/dev/null 与临时目录', () => {
    expect(kind('echo x > /etc/passwd')).toBe('deny');
    expect(kind('echo x > ../../evil.sh')).toBe('deny');
    expect(kind('echo x > ~/secret')).toBe('deny');
    expect(kind('echo x > out.txt')).toBe('ok');
    expect(kind('echo x > "my file.txt"')).toBe('ok');
    expect(kind('echo x > /dev/null')).toBe('ok');
    expect(kind('echo x > /tmp/log.txt')).toBe('ok');
    expect(kind('echo hi >&2')).toBe('ok'); // fd 复制不是写文件
    expect(kind('echo err 2>/dev/null')).toBe('ok');
  });

  it('sed 后门: w/W/e/E 命令字母与 s 命令 w/e flags', () => {
    expect(kind("sed '5w out.txt' file")).toBe('deny');
    expect(kind("sed -i 's/a/b/w out' file")).toBe('deny');
    expect(kind("sed 'e id' file")).toBe('deny');
    expect(kind("sed 's/a/b/' file")).toBe('ok');
    expect(kind("sed -n '5p' file")).toBe('ok');
  });

  it('控制字符与回车硬拦', () => {
    expect(kind('echo hi\x07')).toBe('deny');
    expect(kind('ls\r')).toBe('deny');
  });
});

describe('analyzeBashCommand — 需确认(ask)', () => {
  it('命令替换/进程替换在引号外', () => {
    expect(kind('echo $(date)')).toBe('ask');
    expect(kind('echo `date`')).toBe('ask');
    expect(kind('cat <(ls)')).toBe('ask');
    expect(kind('echo ${HOME}')).toBe('ask');
    expect(kind('echo "$(date)"')).toBe('ask');
    // 单引号与显式转义才是字面量。
    expect(kind("echo '$(date)'")).toBe('ok');
    expect(kind('echo "\\$(date)"')).toBe('ok');
  });

  it('复合攻击: cd+git / cd+重定向 / 写 git 内部并运行 git', () => {
    expect(kind('cd repo && git status')).toBe('ask');
    expect(kind('cd sub && echo y > z.txt')).toBe('ask');
    expect(kind('echo x > .git/hooks/pre-commit && git status')).toBe('ask');
    // 单独 cd 或单独 git 不构成
    expect(kind('cd repo')).toBe('ok');
    expect(kind('git status')).toBe('ok');
  });

  it('重定向目标含变量无法静态解析', () => {
    expect(kind('echo x > $HOME/log.txt')).toBe('ask');
  });

  it('复合命令超过 50 段放弃逐段分析', () => {
    const huge = Array.from({ length: 51 }, () => 'true').join('; ');
    expect(kind(huge)).toBe('ask');
    const fine = Array.from({ length: 50 }, () => 'true').join('; ');
    expect(kind(fine)).toBe('ok');
  });
});

describe('analyzeBashCommand — 只读证明', () => {
  it('白名单命令全部段落只读', () => {
    expect(analyzeBashCommand('ls -la').readOnly).toBe(true);
    expect(analyzeBashCommand('cat a.txt | grep foo').readOnly).toBe(true);
    expect(analyzeBashCommand('git status').readOnly).toBe(true);
    expect(analyzeBashCommand('git log --oneline | head -5').readOnly).toBe(true);
    expect(analyzeBashCommand('git branch').readOnly).toBe(true);
    expect(analyzeBashCommand('git branch --show-current').readOnly).toBe(true);
    expect(analyzeBashCommand('git remote -v').readOnly).toBe(true);
    expect(analyzeBashCommand("sed -n '1,10p' file")).toMatchObject({ kind: 'ok', readOnly: true });
    expect(analyzeBashCommand('find . -name "*.ts"').readOnly).toBe(true);
  });

  it('写入/执行形态不算只读', () => {
    expect(analyzeBashCommand('git push').readOnly).toBe(false);
    expect(analyzeBashCommand('git branch feature/new').readOnly).toBe(false);
    expect(analyzeBashCommand('git tag v1.0.0').readOnly).toBe(false);
    expect(analyzeBashCommand('git remote add origin https://example.com/repo').readOnly).toBe(false);
    expect(analyzeBashCommand('find . -delete').readOnly).toBe(false);
    expect(analyzeBashCommand('npm run build').readOnly).toBe(false);
    expect(analyzeBashCommand('echo x > out.txt').readOnly).toBe(false);
  });
});

describe('analyzeBashCommand — 破坏性警告', () => {
  it('git 数据丢失与历史覆写', () => {
    expect(analyzeBashCommand('git reset --hard HEAD~1').warnings[0]).toContain('丢弃未提交修改');
    expect(analyzeBashCommand('git push -f origin main').warnings[0]).toContain('覆盖远端历史');
    expect(analyzeBashCommand('git commit --amend').warnings[0]).toContain('改写上一次提交');
  });

  it('普通命令无警告', () => {
    expect(analyzeBashCommand('git status').warnings).toHaveLength(0);
  });
});

describe('analyzeBashCommand — 辅助函数', () => {
  it('splitCommandSegments 引号感知', () => {
    expect(splitCommandSegments("echo 'a && b' && ls")).toEqual(["echo 'a && b'", 'ls']);
    expect(splitCommandSegments('cat a | grep b')).toEqual(['cat a', 'grep b']);
  });

  it('stripWrappers 剥离 env 与包装命令', () => {
    expect(stripWrappers('FOO=bar timeout 10 rm -rf /')).toBe('rm -rf /');
    expect(stripWrappers('nice nohup ls')).toBe('ls');
  });
});

describe('interpretExitCode — 退出码语义', () => {
  it('grep/rg 无匹配不是错误', () => {
    expect(interpretExitCode('grep', 1)).toMatchObject({ ok: true });
    expect(interpretExitCode('grep', 1).note).toContain('无匹配');
    expect(interpretExitCode('grep', 2).ok).toBe(false);
  });

  it('diff 有差异/test 条件为假不是错误', () => {
    expect(interpretExitCode('diff', 1).ok).toBe(true);
    expect(interpretExitCode('test', 1).ok).toBe(true);
  });

  it('未知命令走 Unix 约定', () => {
    expect(interpretExitCode('npm', 0).ok).toBe(true);
    expect(interpretExitCode('npm', 1).ok).toBe(false);
  });
});

describe('BashTool 集成', () => {
  it('isReadOnly 说出真实只读性', () => {
    expect(BashTool.isReadOnly({ command: 'ls -la' })).toBe(true);
    expect(BashTool.isReadOnly({ command: 'git status' })).toBe(true);
    expect(BashTool.isReadOnly({ command: 'git push' })).toBe(false);
    expect(BashTool.isReadOnly({ command: 'echo x > out.txt' })).toBe(false);
    expect(BashTool.isReadOnly({ command: 'echo $(date)' })).toBe(false);
    expect(BashTool.isReadOnly({ command: 'git branch feature/new' })).toBe(false);
  });

  it('safetyCheck 只硬拦 deny 档, ask 档放行给默认确认流', () => {
    const meta = BashTool.permissionMeta;
    expect(meta.safetyCheck?.({ command: 'rm -rf /' })).toBe('deny');
    expect(meta.safetyCheck?.({ command: 'echo $(date)' })).toBe('continue');
    expect(meta.safetyCheck?.({ command: 'ls' })).toBe('continue');
  });
});
