// 从开发者明确提供的许可制品中注入并校验 Cubism Core，不从公开仓库下载二进制。
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJson, requireRegularFile, sha256File } from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const config = readJson(path.join(desktopRoot, 'release-config.json'));
const argumentIndex = process.argv.indexOf('--source');
const source = argumentIndex >= 0
  ? process.argv[argumentIndex + 1]
  : process.env['EMA_CUBISM_CORE_PATH'];
if (!source) {
  throw new Error('缺少 --source <Cubism Core 路径> 或 EMA_CUBISM_CORE_PATH');
}

const resolvedSource = path.resolve(source);
requireRegularFile(resolvedSource, 'Cubism Core 源制品');
const hash = sha256File(resolvedSource);
if (!config.cubismCore.allowedSha256.includes(hash)) {
  throw new Error(`Cubism Core SHA-256 未被 release-config 批准: ${hash}`);
}

const destination = path.join(
  desktopRoot,
  'public',
  'cubism',
  config.cubismCore.fileName,
);
mkdirSync(path.dirname(destination), { recursive: true });
if (resolvedSource !== path.resolve(destination)) {
  copyFileSync(resolvedSource, destination);
}
process.stdout.write(`Cubism Core injected: ${hash}\n`);
