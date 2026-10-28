export class ComputerUseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    // possible 表示失败前可能已经输入或操作了一部分, 不能自动重试整条动作.
    readonly effect: 'none' | 'possible' = 'none',
  ) {
    super(message);
    this.name = 'ComputerUseError';
  }
}
