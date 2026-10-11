// tsc 已在 dist/templates 生成加载器. 这里只复制模板资产, 不能清空该目录删除加载器.
// build 在编译前清理 dist, 因而已删除的模板不会残留.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../templates');
const target = path.resolve(here, '../dist/templates');

await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: filename => !filename.endsWith('.ts'),
});
console.log(`copied templates -> ${path.relative(process.cwd(), target)}`);
