// 阻止 Desktop、Tauri、Server 与 Narrative Bridge 的正式发布版本发生漂移。
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
const serverVersion = readJson(path.join(workspaceRoot, 'apps', 'server', 'package.json')).version;
const narrativeBridgePyproject = readFileSync(
  path.join(workspaceRoot, 'bridges', 'narrative', 'pyproject.toml'),
  'utf8',
);
const narrativeBridgeVersion = narrativeBridgePyproject.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];

const versions = { desktopVersion, tauriVersion, serverVersion, narrativeBridgeVersion };
if (!narrativeBridgeVersion || new Set(Object.values(versions)).size !== 1) {
  throw new Error(`发布版本不一致: ${JSON.stringify(versions)}`);
}
process.stdout.write(`release versions verified: ${desktopVersion}\n`);
