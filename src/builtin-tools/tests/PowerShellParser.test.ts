// PowerShell AST 变换层测试:罐装原始 JSON → 变换函数,不起真实 pwsh 进程。
// 重点覆盖安全语义:非 ASCII 命令名降级、引号剥除、模块前缀、重定向去重与 $null 汇。
import { describe, expect, it } from 'vitest';
import {
  classifyCommandName,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getFileRedirections,
  hasCommandNamed,
  isNullRedirectionTarget,
  mapElementType,
  MAX_COMMAND_LENGTH,
  stripModulePrefix,
  transformCommandAst,
  transformRedirection,
  transformStatement,
  WINDOWS_MAX_COMMAND_LENGTH,
  type ParsedPowerShellCommand,
  type RawPipelineElement,
  type RawStatement,
} from '../tools/PowerShellTool/psParser.js';

function cmdElement(name: string, args: string[] = []): RawPipelineElement {
  return {
    type: 'CommandAst',
    text: [name, ...args].join(' '),
    commandElements: [
      { type: 'StringConstantExpressionAst', text: name, value: name },
      ...args.map((a) => ({ type: 'StringConstantExpressionAst', text: a, value: a })),
    ],
  };
}

function parsedOf(overrides: Partial<ParsedPowerShellCommand>): ParsedPowerShellCommand {
  return {
    valid: true,
    errors: [],
    statements: [],
    variables: [],
    hasStopParsing: false,
    originalCommand: '',
    ...overrides,
  };
}

describe('mapElementType — 安全映射', () => {
  it('ArrayExpressionAst 归并为 SubExpression(@() 里能藏命令)', () => {
    expect(mapElementType('ArrayExpressionAst')).toBe('SubExpression');
    expect(mapElementType('SubExpressionAst')).toBe('SubExpression');
  });

  it('数字字面量 ConstantExpressionAst 视为 StringConstant(数字是惰性值)', () => {
    expect(mapElementType('ConstantExpressionAst')).toBe('StringConstant');
  });

  it('CommandExpressionAst 委托内层类型', () => {
    expect(mapElementType('CommandExpressionAst', 'ScriptBlockExpressionAst')).toBe('ScriptBlock');
    expect(mapElementType('CommandExpressionAst', 'SomethingUnknown')).toBe('Other');
  });
});

describe('transformCommandAst — 命令名安全', () => {
  it('命令名剥引号:& \'Invoke-Expression\' 能命中后续检查', () => {
    const el = transformCommandAst({
      type: 'CommandAst',
      text: "& 'Invoke-Expression' 'x'",
      commandElements: [
        { type: 'StringConstantExpressionAst', text: "'Invoke-Expression'" },
        { type: 'StringConstantExpressionAst', text: "'x'", value: 'x' },
      ],
    });
    expect(el.name).toBe('Invoke-Expression');
  });

  it('非 ASCII 命令名强制 application,挡住 Unicode 折叠绕过', () => {
    const el = transformCommandAst(cmdElement('ſtart-proceſſ'));
    expect(el.nameType).toBe('application');
  });

  it('nameType 由未剥前缀的名字计算:scripts\\Get-Process 是路径不是 cmdlet', () => {
    const el = transformCommandAst(cmdElement('scripts\\Get-Process'));
    expect(el.nameType).toBe('application');
    // 剥后名仍给 deny 匹配用(fail-safe 方向)。
    expect(el.name).toBe('Get-Process');
  });

  it('参数保留原文(带破折号),字符串常量用解析值', () => {
    const el = transformCommandAst({
      type: 'CommandAst',
      text: 'Get-Content -Path "a b.txt"',
      commandElements: [
        { type: 'StringConstantExpressionAst', text: 'Get-Content', value: 'Get-Content' },
        { type: 'CommandParameterAst', text: '-Path' },
        { type: 'StringConstantExpressionAst', text: '"a b.txt"', value: 'a b.txt' },
      ],
    });
    expect(el.args).toEqual(['-Path', 'a b.txt']);
    expect(el.elementTypes).toEqual(['StringConstant', 'Parameter', 'StringConstant']);
  });
});

describe('stripModulePrefix / classifyCommandName', () => {
  it('剥模块前缀但不动文件路径', () => {
    expect(stripModulePrefix('Microsoft.PowerShell.Utility\\Invoke-Expression')).toBe('Invoke-Expression');
    expect(stripModulePrefix('C:\\tools\\x.exe')).toBe('C:\\tools\\x.exe');
    expect(stripModulePrefix('\\\\server\\share\\x.exe')).toBe('\\\\server\\share\\x.exe');
    expect(stripModulePrefix('.\\x.ps1')).toBe('.\\x.ps1');
  });

  it('cmdlet/application/unknown 三态', () => {
    expect(classifyCommandName('Get-Process')).toBe('cmdlet');
    expect(classifyCommandName('git.exe')).toBe('application');
    expect(classifyCommandName('git')).toBe('unknown');
  });
});

describe('transformStatement — 重定向', () => {
  it('深层与直接重定向按 (operator,target) 去重', () => {
    const raw: RawStatement = {
      type: 'PipelineAst',
      text: 'Get-ChildItem > out.txt',
      elements: [
        {
          ...cmdElement('Get-ChildItem'),
          redirections: [{ type: 'FileRedirectionAst', fromStream: 'Output', locationText: 'out.txt' }],
        },
      ],
      // PS1 深层 FindAll 会重复发现同一处重定向。
      redirections: [{ type: 'FileRedirectionAst', fromStream: 'Output', locationText: 'out.txt' }],
    };
    const stmt = transformStatement(raw);
    expect(stmt.redirections).toHaveLength(1);
    expect(stmt.redirections[0]).toMatchObject({ operator: '>', target: 'out.txt' });
  });

  it('合并重定向与 $null 汇不算文件写', () => {
    expect(transformRedirection({ type: 'MergingRedirectionAst' }).isMerging).toBe(true);
    expect(isNullRedirectionTarget('$null')).toBe(true);
    expect(isNullRedirectionTarget('${null}')).toBe(true);
    expect(isNullRedirectionTarget('${ null }')).toBe(false);
  });
});

describe('分析辅助', () => {
  it('hasCommandNamed 别名双向命中(rm ↔ Remove-Item)', () => {
    const parsed = parsedOf({
      statements: [{
        statementType: 'PipelineAst',
        commands: [transformCommandAst(cmdElement('rm', ['-Recurse']))],
        redirections: [],
        text: 'rm -Recurse',
      }],
    });
    expect(hasCommandNamed(parsed, 'Remove-Item')).toBe(true);
    expect(hasCommandNamed(parsed, 'ri')).toBe(true);
    expect(hasCommandNamed(parsed, 'Get-Process')).toBe(false);
  });

  it('deriveSecurityFlags 聚合元素类型与 securityPatterns 双通道', () => {
    const cmd = transformCommandAst({
      type: 'CommandAst',
      text: 'Write-Output "$(x)"',
      commandElements: [
        { type: 'StringConstantExpressionAst', text: 'Write-Output', value: 'Write-Output' },
        { type: 'ExpandableStringExpressionAst', text: '"$(x)"', value: '$(x)' },
      ],
    });
    const parsed = parsedOf({
      statements: [{
        statementType: 'PipelineAst',
        commands: [cmd],
        redirections: [],
        text: '',
        securityPatterns: { hasScriptBlocks: true },
      }],
    });
    const flags = deriveSecurityFlags(parsed);
    expect(flags.hasExpandableStrings).toBe(true);
    // securityPatterns 兜底通道。
    expect(flags.hasScriptBlocks).toBe(true);
    expect(flags.hasSubExpressions).toBe(false);
  });

  it('getFileRedirections 排除合并与 $null', () => {
    const parsed = parsedOf({
      statements: [{
        statementType: 'PipelineAst',
        commands: [],
        redirections: [
          { operator: '>', target: 'real.txt', isMerging: false },
          { operator: '2>&1', target: '', isMerging: true },
          { operator: '>', target: '$null', isMerging: false },
        ],
        text: '',
      }],
    });
    expect(getFileRedirections(parsed)).toEqual([
      { operator: '>', target: 'real.txt', isMerging: false },
    ]);
  });

  it('commandHasArgAbbreviation 剥冒号值与反引号', () => {
    const el = transformCommandAst({
      type: 'CommandAst',
      text: 'pwsh -en:QUJD',
      commandElements: [
        { type: 'StringConstantExpressionAst', text: 'pwsh', value: 'pwsh' },
        { type: 'CommandParameterAst', text: '-en:QUJD' },
      ],
    });
    expect(commandHasArgAbbreviation(el, '-encodedcommand', '-e')).toBe(true);
    expect(commandHasArgAbbreviation(el, '-executionpolicy', '-ex')).toBe(false);
  });
});

describe('argv 预算', () => {
  it('Windows 预算是正数且远小于 32K;由脚本体长现算不过期', () => {
    expect(WINDOWS_MAX_COMMAND_LENGTH).toBeGreaterThan(0);
    expect(WINDOWS_MAX_COMMAND_LENGTH).toBeLessThan(32_767);
    expect(MAX_COMMAND_LENGTH).toBeGreaterThan(0);
  });
});
