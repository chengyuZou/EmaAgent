import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [appRoot, profileRoot, expectedNode] = process.argv.slice(2);
assert.equal(process.versions.node, expectedNode, '随包 Node 版本不匹配');
const require = createRequire(path.join(appRoot, 'package.json'));
const storageRequire = createRequire(path.join(appRoot, 'node_modules', '@ema-agent', 'storage', 'package.json'));
const captureRequire = createRequire(path.join(appRoot, 'node_modules', '@ema-agent', 'vishot-capture', 'package.json'));
const Database = storageRequire('better-sqlite3');
const sharp = require('sharp');
const db = new Database(path.join(profileRoot, 'narrative', 'narrative.db'), { readonly: true });
try {
  for (const table of ['chunks', 'entities', 'relations']) {
    const rows = db.prepare(`SELECT timeline_id, COUNT(*) AS count FROM ${table} GROUP BY timeline_id`).all();
    assert.deepEqual(rows.map(row => row.timeline_id).sort(), ['1st_Loop', '2nd_Loop', '3rd_Loop']);
    assert.ok(rows.every(row => row.count > 0), `${table} 缺少剧情数据`);
  }
} finally {
  db.close();
}
await sharp({ create: { width: 1, height: 1, channels: 4, background: '#000000' } }).png().toBuffer();
if (process.platform === 'win32') {
  const executable = path.join(appRoot, 'node_modules/@ema-agent/computer-use/bin/ema-computer-use.exe');
  assert.ok(existsSync(executable), '缺少随包电脑操控程序');
  // 只测试真实进程通信和退出, 不在发布检查中启动控制或采集用户屏幕.
  const reply = execFileSync(executable, [], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'computer.ping', params: {} })}\n`,
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.equal(JSON.parse(reply.trim()).result.ok, true, '电脑操控程序未正确响应');
}
const ffmpeg = realpathSync(captureRequire('ffmpeg-static'));
const relative = path.relative(appRoot, ffmpeg);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'FFmpeg 不在发布目录内');
assert.ok(existsSync(`${ffmpeg}.LICENSE`), '缺少 FFmpeg 许可证');
assert.ok(existsSync(`${ffmpeg}.README`), '缺少 FFmpeg 构建说明');
if (process.platform !== 'win32') {
  const devices = execFileSync(ffmpeg, ['-hide_banner', '-devices'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  const device = { darwin: 'avfoundation', linux: 'x11grab' }[process.platform];
  assert.ok(device && devices.split(/\r?\n/u).some(line => new RegExp(`^\\s*D\\s+${device}\\s`).test(line)),
    `FFmpeg 缺少 ${device} 截图能力`);
}
console.log('随包 Node、SQLite、Sharp、FFmpeg 和三周目剧情检查通过');
