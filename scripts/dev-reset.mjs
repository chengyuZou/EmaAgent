// 开发期重置:删除 EmaAgent 可重建的本地状态,让下次启动走完整的首次初始化流程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const profileRoot = process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent');

// 默认运行时只允许清理固定的应用目录。测试可以用 EMA_PROFILE_DIR 指向临时目录。
if (!process.env['EMA_PROFILE_DIR'] && path.basename(profileRoot) !== '.ema-agent') {
  console.error(`拒绝重置非 EmaAgent 目录: ${profileRoot}`);
  process.exit(1);
}
if (!fs.existsSync(profileRoot)) {
  console.log(`Profile 目录不存在,无需重置: ${profileRoot}`);
  process.exit(0);
}

const removed = [];

function remove(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

function removeSqlite(databasePath) {
  for (const suffix of ['', '-wal', '-shm']) {
    remove(`${databasePath}${suffix}`);
  }
}

removeSqlite(path.join(profileRoot, 'profile.db'));

// data/ 是当前唯一业务数据目录。整目录删除可同时清掉 data.db、Session 文件和暂存内容。
remove(path.join(profileRoot, 'data'));

// 这些目录由首次启动、后端业务或用户操作重新建立。
for (const directory of [
  'characters',
  'kb',
  'memories',
  'narrative',
  'resources',
  'skills',
]) {
  remove(path.join(profileRoot, directory));
}

// 桌面设置和进程协调文件也属于本次运行状态,首次启动不应继承它们。
for (const file of [
  'bridge.port',
  'desktop.json',
  'lockfile.json',
]) {
  remove(path.join(profileRoot, file));
}

// 单库化前的 data.db 与 registry.json 已没有读取方,只在开发机升级后作为残留清掉。
removeSqlite(path.join(profileRoot, 'data.db'));
remove(path.join(profileRoot, 'registry.json'));

if (removed.length === 0) {
  console.log('没有可清理的内容。');
} else {
  console.log('已删除:');
  for (const target of removed) {
    console.log(`  ${target}`);
  }
}

console.log('已保留 logs/ 与 workspace/。');
console.log('重置完成。下次启动将重建数据库和内置资源;Provider 需在设置页重新添加。');
