// 安装并发语义测试:不同 installKey 并行执行,同一 key 严格串行(目标目录 rm+rename 不互踩)。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillRow, SkillsRepo } from '@ema-agent/storage';
import { installSkillFromSite } from '../installer/install.js';
import { createSkillStore } from '../store.js';
import type { SkillSiteEntry } from '../sources/sites/siteStore.js';

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skill-install-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRepo(): SkillsRepo {
  const rows = new Map<string, SkillRow>();
  return {
    upsertById: (row) => { rows.set(row.id, { ...row }); },
    findById: (id) => rows.get(id) ?? null,
    listAll: () => [...rows.values()],
    listBySite: (siteId) => [...rows.values()].filter((r) => r.site_id === siteId),
    deleteById: (id) => { rows.delete(id); },
  } as SkillsRepo;
}

function entryOf(id: string): SkillSiteEntry {
  return {
    id,
    name: id,
    description: '',
    version: '1.0.0',
    bundleUrl: `https://x/${id}.zip`,
    bundleSha256: 'unused-by-stub',
    sizeBytes: 1,
  };
}

function zipOf(name: string): Uint8Array {
  const md = `---\nname: ${name}\nversion: 1.0.0\ndescription: d\n---\n# ${name}\n`;
  return zipSync({ 'SKILL.md': new TextEncoder().encode(md) });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('installSkillFromSite — 并发语义', () => {
  it('不同 key 并行(在飞峰值 ≥2),同一 key 串行(第二个等第一个收尾)', async () => {
    const userRoot = makeDir();
    const store = createSkillStore({ repo: makeRepo(), userRoot });

    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const downloader = async (input: { bundleUrl: string }) => {
      const name = input.bundleUrl.replace('https://x/', '').replace('.zip', '');
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${name}`);
      await sleep(40);
      order.push(`end:${name}`);
      inFlight -= 1;
      return zipOf(name);
    };

    // 两个不同 key + 同 key 再来一发。
    await Promise.all([
      installSkillFromSite({ siteId: 's', entry: entryOf('a') }, { store, userRoot, downloader }),
      installSkillFromSite({ siteId: 's', entry: entryOf('b') }, { store, userRoot, downloader }),
      installSkillFromSite({ siteId: 's', entry: entryOf('a') }, { store, userRoot, downloader }),
    ]);

    // 跨 key 并行:a、b 的 start 都出现在第一个 end 之前。
    const firstEnd = order.findIndex((event) => event.startsWith('end:'));
    const startsBeforeFirstEnd = order.slice(0, firstEnd).filter((event) => event.startsWith('start:'));
    expect(startsBeforeFirstEnd.length).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);

    // 同 key 串行:第二个 a 的 start 在第一个 a 的 end 之后。
    const aEvents = order.filter((event) => event.endsWith(':a'));
    expect(aEvents).toEqual(['start:a', 'end:a', 'start:a', 'end:a']);
  });
});
