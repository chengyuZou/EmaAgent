// 退出码语义: 标准 Unix 约定(0 成功/非 0 失败)对 grep/diff/test 等不成立,
// 模型把 "无匹配" 误判为执行失败会发起无效重试。按基命令查表解释。

export interface ExitInterpretation {
  /** 按命令语义是否属于正常结果(grep 无匹配/diff 有差异/test 条件为假)。 */
  ok: boolean;
  /** 给人和模型看的解释, 仅在语义与 Unix 约定不同时给出。 */
  note?: string;
}

interface SemanticsRule {
  /** 退出码 → [ok, note?]。 */
  codes: Record<number, [boolean, string?]>;
  /** 未命中表时的默认: 0 正常, 其余错误。 */
}

const EXIT_SEMANTICS: Record<string, SemanticsRule['codes']> = {
  grep: { 0: [true], 1: [true, 'grep: 退出码 1 表示无匹配, 不是错误'] },
  egrep: { 0: [true], 1: [true, 'grep: 退出码 1 表示无匹配, 不是错误'] },
  fgrep: { 0: [true], 1: [true, 'grep: 退出码 1 表示无匹配, 不是错误'] },
  rg: { 0: [true], 1: [true, 'rg: 退出码 1 表示无匹配, 不是错误'] },
  diff: { 0: [true], 1: [true, 'diff: 退出码 1 表示存在差异, 不是错误'] },
  test: { 0: [true], 1: [true, 'test: 退出码 1 表示条件为假, 不是错误'] },
  '[': { 0: [true], 1: [true, 'test: 退出码 1 表示条件为假, 不是错误'] },
  find: { 0: [true], 1: [true, 'find: 退出码 1 表示部分路径不可访问, 结果仍有效'] },
};

/**
 * 解释命令退出码。base 为基命令(无路径), 由调用方从命令行提取。
 * 复合命令语义以最后一段为准(管道/&& 链的退出码来自末尾)。
 */
export function interpretExitCode(base: string, exitCode: number): ExitInterpretation {
  const table = EXIT_SEMANTICS[base];
  if (!table) return { ok: exitCode === 0 };
  const hit = table[exitCode];
  if (!hit) return { ok: false };
  const [ok, note] = hit;
  return note ? { ok, note } : { ok };
}
