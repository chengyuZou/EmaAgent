import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MCP_LOCAL_COMMANDS = ['npx', 'uvx', 'bunx', 'python3'] as const;
export type McpLocalCommand = typeof MCP_LOCAL_COMMANDS[number];

export interface McpLocalCommandInspection {
  readonly command: McpLocalCommand;
  readonly selectedPath: string | null;
  readonly candidatePaths: readonly string[];
  readonly version: string | null;
}

export class McpLocalCommandEnvironment {
  async inspect(): Promise<readonly McpLocalCommandInspection[]> {
    return Promise.all(MCP_LOCAL_COMMANDS.map(command => inspectCommand(command)));
  }
}

async function inspectCommand(command: McpLocalCommand): Promise<McpLocalCommandInspection> {
  const candidatePaths = command === 'python3'
    ? uniquePaths([...findCommandCandidates('python3'), ...findCommandCandidates('python')])
    : findCommandCandidates(command);
  let selectedPath = candidatePaths[0] ?? null;
  let version = selectedPath ? await readVersion(selectedPath) : null;
  if (command === 'python3') {
    selectedPath = null;
    version = null;
    for (const candidate of candidatePaths) {
      const candidateVersion = await readVersion(candidate);
      if (!candidateVersion || !/^Python 3(?:\.|\b)/i.test(candidateVersion)) continue;
      selectedPath = candidate;
      version = candidateVersion;
      break;
    }
  }
  return { command, selectedPath, candidatePaths, version };
}

function findCommandCandidates(command: string): string[] {
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(extension => `${command}${extension.toLowerCase()}`)
    : [command];
  const found: string[] = [];
  const seen = new Set<string>();

  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      const identity = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(identity)) continue;
      seen.add(identity);
      found.push(candidate);
    }
  }
  return found;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(candidate => {
    const identity = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function readVersion(executable: string): Promise<string | null> {
  const windowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
  const command = windowsScript ? (process.env.ComSpec ?? 'cmd.exe') : executable;
  const args = windowsScript ? ['/d', '/c', executable, '--version'] : ['--version'];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), 50_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => {
      clearTimeout(timer);
      const firstLine = output.trim().split(/\r?\n/, 1)[0]?.trim();
      resolve(code === 0 && firstLine ? firstLine : null);
    });
  });
}
