// 阻止 Desktop、Tauri、LocalHost 与 Bridge 的正式发布版本发生漂移。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJson } from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(desktopRoot, '..', '..');
const desktopVersion = readJson(path.join(desktopRoot, 'package.json')).version;
const tauriVersion = readJson(path.join(desktopRoot, 'src-tauri', 'tauri.conf.json')).version;
const localHostVersion = readJson(path.join(workspaceRoot, 'apps', 'localHost', 'package.json')).version;
const bridgePyproject = readFileSync(
  path.join(workspaceRoot, 'apps', 'bridge', 'pyproject.toml'),
  'utf8',
);
const bridgeVersion = bridgePyproject.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];

const versions = { desktopVersion, tauriVersion, localHostVersion, bridgeVersion };
if (!bridgeVersion || new Set(Object.values(versions)).size !== 1) {
  throw new Error(`发布版本不一致: ${JSON.stringify(versions)}`);
}
process.stdout.write(`release versions verified: ${desktopVersion}\n`);
