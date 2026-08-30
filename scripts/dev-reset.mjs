// 开发期重置：清空 EmaAgent 本地库与已铺资源，下次启动从干净状态重建。
// 只服务开发联调。系统凭据库（Provider Key 等）不在此目录，不受影响；
// profile.db 里的 Provider 配置会被清掉，需在设置页重新添加。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const profileRoot = process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent');

// 最低限度校验：只认默认目录名或显式环境变量，防误指到别的目录。
if (!process.env['EMA_PROFILE_DIR'] && path.basename(profileRoot) !== '.ema-agent') {
  console.error(`拒绝重置非 EmaAgent 目录: ${profileRoot}`);
  process.exit(1);
}
if (!fs.existsSync(profileRoot)) {
  console.log(`profile 目录不存在，无需重置: ${profileRoot}`);
  process.exit(0);
}

const removed = [];
function remove(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}
function removeDb(file) {
  for (const suffix of ['', '-wal', '-shm']) remove(`${file}${suffix}`);
}

// 设置/角色/Provider 库。
removeDb(path.join(profileRoot, 'profile.db'));

// registry.json 登记的全部数据目录：清业务库与 Session 文件树；注册表本身保留。
const registryFile = path.join(profileRoot, 'registry.json');
if (fs.existsSync(registryFile)) {
  try {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    for (const dir of registry.dirs ?? []) {
      if (typeof dir?.path !== 'string') continue;
      removeDb(path.join(dir.path, 'data.db'));
      remove(path.join(dir.path, 'sessions'));
    }
  } catch {
    console.warn('registry.json 解析失败，跳过数据目录清理');
  }
}

// 已铺资源：下次启动从仓库种子/发布包重铺。
remove(path.join(profileRoot, 'characters'));
remove(path.join(profileRoot, 'resources'));
remove(path.join(profileRoot, 'narrative'));

if (removed.length === 0) {
  console.log('没有可清理的内容。');
} else {
  console.log('已删除:');
  for (const target of removed) console.log(`  ${target}`);
}
console.log('重置完成。下次启动将重建数据库并重铺内置角色与技能；Provider 需在设置页重新添加。');
