import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkReleaseVersions } from '../scripts/releaseCheck.mjs';

const version = '0.1.0-alpha.1';
const files = [
  'package.json',
  'package-lock.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/Cargo.toml',
];

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ema-release-versions-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of files) {
    const filename = path.join(directory, file);
    mkdirSync(path.dirname(filename), { recursive: true });
    if (file.endsWith('.toml')) {
      writeFileSync(filename, `[package]\nname = "ema-desktop"\nversion = "${version}"\n\n[dependencies]\nversion = "9.9.9"\n`);
    } else if (file === 'package-lock.json') {
      writeFileSync(filename, JSON.stringify({ version, packages: { '': { version } } }));
    } else {
      writeFileSync(filename, JSON.stringify({ version }));
    }
  }
  return directory;
}

test('accepts matching prerelease versions without changing files', context => {
  const directory = fixture(context);
  const before = files.map(file => readFileSync(path.join(directory, file), 'utf8'));
  assert.doesNotThrow(() => checkReleaseVersions(directory));
  assert.deepEqual(files.map(file => readFileSync(path.join(directory, file), 'utf8')), before);
});

for (const file of files) {
  test(`rejects a different version in ${file} and reports all version locations`, context => {
    const directory = fixture(context);
    const filename = path.join(directory, file);
    writeFileSync(filename, readFileSync(filename, 'utf8').replace(version, '0.1.0-alpha.2'));
    assert.throws(() => checkReleaseVersions(directory), error => {
      for (const expectedFile of files) assert.ok(error.message.includes(expectedFile));
      assert.ok(error.message.includes(version));
      assert.ok(error.message.includes('0.1.0-alpha.2'));
      return true;
    });
  });
}

test('rejects a different root package version inside package-lock.json', context => {
  const directory = fixture(context);
  const filename = path.join(directory, 'package-lock.json');
  const packageLock = JSON.parse(readFileSync(filename, 'utf8'));
  packageLock.packages[''].version = '0.1.0-alpha.2';
  writeFileSync(filename, JSON.stringify(packageLock));
  assert.throws(() => checkReleaseVersions(directory), error => {
    assert.ok(error.message.includes('package-lock.json packages[""].version: "0.1.0-alpha.2"'));
    return true;
  });
});

test('rejects a missing root version', context => {
  const directory = fixture(context);
  writeFileSync(path.join(directory, 'package.json'), '{}');
  assert.throws(() => checkReleaseVersions(directory), /package.json: \(missing\)/u);
});

test('does not take a dependency version as the Cargo package version', context => {
  const directory = fixture(context);
  writeFileSync(path.join(directory, 'apps/desktop/src-tauri/Cargo.toml'), `[package]\nname = "ema-desktop"\n[dependencies]\nversion = "${version}"\n`);
  assert.throws(() => checkReleaseVersions(directory), /Cargo.toml: \(missing\)/u);
});

test('release entry rejects a root mismatch before tool checks or builds', context => {
  const directory = fixture(context);
  const desktop = path.join(directory, 'apps/desktop');
  const scripts = path.join(desktop, 'scripts');
  mkdirSync(scripts);
  for (const file of [
    'release.mjs',
    'releaseCheck.mjs',
    'releaseWorkspace.mjs',
    'buildComputerUse.mjs',
  ]) {
    copyFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(scripts, file));
  }
  writeFileSync(path.join(desktop, 'release-config.json'), JSON.stringify({ nodeVersion: 'not-installed' }));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.2' }));
  const result = spawnSync(process.execPath, [path.join(scripts, 'release.mjs')], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /发布版本必须与根目录 package.json 一致/u);
  assert.doesNotMatch(result.stdout, /\[发布\]/u);
});
