// 这是 System 包的统一出口，外部代码从这里拿到本机磁盘信息与系统级安装能力。

export { getDisksInfo } from './disk.js';
export type { DiskInfo } from './disk.js';
export { installGitViaWinget } from './gitInstall.js';
export type { GitInstallResult } from './gitInstall.js';
export type { SystemEvent, SystemWarningEvent } from './events.js';
