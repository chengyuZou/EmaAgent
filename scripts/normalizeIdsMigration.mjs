// 从本轮 Git 基线恢复原始排版，只保留 Contracts 到 IDs 的机械引用变化。
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const listed = execFileSync(
  'git',
  ['grep', '-l', '-z', '@ema-agent/contracts', 'HEAD', '--', 'src', 'apps'],
  { cwd: root },
).toString('utf8');

const paths = listed
  .split('\0')
  .filter(Boolean)
  .map((entry) => entry.replace(/^HEAD:/, ''));

function moveTurnTypes(source, filePath) {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return source;

  const movedTypes = new Set();
  const rewritten = source.replace(
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]@ema-agent\/ids['"];/g,
    (statement, typeKeyword, bindings) => {
      const retained = [];
      for (const rawBinding of bindings.split(',')) {
        const binding = rawBinding.trim();
        if (!binding) continue;
        const name = binding.replace(/^type\s+/, '').split(/\s+as\s+/)[0];
        if (name === 'TurnMode' || name === 'TurnStatus') movedTypes.add(name);
        else retained.push(binding);
      }

      if (retained.length === 0) return '';
      if (statement.includes('\n')) {
        return `import ${typeKeyword ?? ''}{\n  ${retained.join(',\n  ')},\n} from '@ema-agent/ids';`;
      }
      return `import ${typeKeyword ?? ''}{ ${retained.join(', ')} } from '@ema-agent/ids';`;
    },
  );

  if (movedTypes.size === 0) return rewritten;
  const modulePath = filePath === 'src/turn/events.ts' ? './turns.js' : '@ema-agent/turn';
  return `import type { ${[...movedTypes].join(', ')} } from '${modulePath}';\n${rewritten}`;
}

for (const filePath of paths) {
  const original = execFileSync('git', ['show', `HEAD:${filePath}`], { cwd: root }).toString('utf8');
  const renamed = original.replaceAll('@ema-agent/contracts', '@ema-agent/ids');
  const output = moveTurnTypes(renamed, filePath);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await writeFile(path.join(root, filePath), output, 'utf8');
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await delay(200 * attempt);
    }
  }
}
