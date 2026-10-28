import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function buildComputerUse({ release = false, offline = false } = {}) {
  if (process.platform !== 'win32') return null;
  const project = path.join(repository, 'apps/computer-use');
  const args = ['build', '--locked'];
  if (release) args.push('--release');
  if (offline) args.push('--offline');
  execFileSync('cargo', args, { cwd: project, stdio: 'inherit', windowsHide: true });
  const profile = release ? 'release' : 'debug';
  const source = path.join(project, 'target', profile, 'ema-computer-use.exe');
  const destination = path.join(repository, 'src/computer-use/bin/ema-computer-use.exe');
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildComputerUse({
    release: process.argv.includes('--release'),
    offline: process.argv.includes('--offline'),
  });
}
