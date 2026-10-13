// 开发期重置会删除用户数据, 不是清缓存. 下次启动只恢复随应用提供的内置资源.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const requestedRoot = path.resolve(
  process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent'),
);
const workspaceRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const profileRoot = fs.existsSync(requestedRoot) ? fs.realpathSync(requestedRoot) : requestedRoot;

// 环境变量可能填错, 或指向一个目录链接. 删除前按实际路径排除根目录、用户主目录和仓库.
for (const protectedRoot of [path.parse(profileRoot).root, fs.realpathSync(os.homedir()), workspaceRoot]) {
  const relative = path.relative(profileRoot, protectedRoot);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`拒绝重置根目录、用户主目录、仓库或它们的上级目录: ${profileRoot}`);
  }
}
if (!fs.existsSync(profileRoot)) {
  console.log(`应用数据目录不存在, 无需重置: ${profileRoot}`);
  process.exit(0);
}

const lockPath = path.join(profileRoot, 'lockfile.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.hostname === os.hostname() && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
    let running = true;
    try {
      process.kill(lock.pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
      running = false;
    }
    if (running) {
      throw new Error(`Server 仍在运行 (pid=${lock.pid}), 请先退出 EmaAgent 再重置`);
    }
  }
}

console.log(`将重置应用数据: ${profileRoot}`);
console.log('会删除会话、附件、音频、角色、记忆、技能、壁纸、Provider 和设置; 不保留自定义内容');
// 首次启动由 profile.db 是否存在决定. 整体清理应用状态, 避免只删数据库却继承文件状态.
// logs 和 workspace 不决定初始化; 保留日志和其中的用户工作文件.
for (const entry of fs.readdirSync(profileRoot, { withFileTypes: true })) {
  if (entry.name === 'logs' || entry.name === 'workspace') {
    continue;
  }
  const target = path.join(profileRoot, entry.name);
  if (path.dirname(target) !== profileRoot) {
    throw new Error(`重置目标超出应用数据目录: ${target}`);
  }
  if (entry.isSymbolicLink()) {
    // 只移除链接, 不删除它指向的目录内容.
    fs.unlinkSync(target);
  } else {
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(`已删除: ${target}`);
}

console.log('已保留 logs/ 与 workspace/');
console.log('重置完成。下次启动将重新初始化数据库和内置资源; 自定义内容需从备份恢复');
