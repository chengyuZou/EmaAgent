import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import path from 'node:path';

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function parseTargetArgument(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--target');
  if (index >= 0) {
    const explicit = argv[index + 1];
    if (!explicit || explicit.startsWith('--')) {
      throw new Error('--target 后面需要目标平台名称');
    }
    return explicit;
  }
  return process.env['TAURI_ENV_TARGET_TRIPLE'] || rustHostTarget();
}

export function rustHostTarget() {
  const verbose = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' });
  const hostLine = verbose.split(/\r?\n/u).find((line) => line.startsWith('host: '));
  if (!hostLine) {
    throw new Error('rustc -Vv 未返回 host target triple');
  }
  return hostLine.slice('host: '.length).trim();
}

export function executableSuffix(target) {
  return target.includes('windows') ? '.exe' : '';
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function requireRegularFile(filePath, label) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch (error) {
    throw new Error(`${label} 不可读取: ${filePath}`, { cause: error });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} 不是普通文件或为空: ${filePath}`);
  }
}

/** 从部署目录解析 FFmpeg, 并检查真实二进制的截图能力. 不截取发布机器的屏幕. */
export function verifyCaptureBinary(appRoot, nodeBinary = process.execPath) {
  const binary = execFileSync(nodeBinary, ['--input-type=module', '--eval', `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.resolve('@ema-agent/vishot-capture'));
    process.stdout.write(require('ffmpeg-static') || '');
  `], { cwd: appRoot, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
  const relative = path.relative(appRoot, binary);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`FFmpeg 没有包含在 Server 发布目录中: ${binary}`);
  }
  requireRegularFile(binary, '随包 FFmpeg');
  requireRegularFile(`${binary}.LICENSE`, 'FFmpeg 许可证');
  requireRegularFile(`${binary}.README`, 'FFmpeg 构建说明');
  const devices = execFileSync(binary, ['-hide_banner', '-devices'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  const device = { win32: 'gdigrab', darwin: 'avfoundation', linux: 'x11grab' }[process.platform];
  if (!device || !devices.split(/\r?\n/).some(line => new RegExp(`^\\s*D\\s+${device}\\s`).test(line))) {
    throw new Error(`随包 FFmpeg 缺少 ${device ?? process.platform} 屏幕采集能力, 不能发布为支持截图的安装包.`);
  }
  return binary;
}
