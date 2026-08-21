// 构建时把 src/memory/templates 下的 md 资产复制到 dist/templates,
// 供 templates/loader.ts 运行时读取(tsc 不复制非 ts 文件)。
// 先清空 dist/templates,避免已删除模板的残留。
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../templates');
const target = path.resolve(here, '../dist/templates');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`copied templates -> ${path.relative(process.cwd(), target)}`);
