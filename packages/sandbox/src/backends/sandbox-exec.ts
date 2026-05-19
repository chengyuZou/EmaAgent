import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';

/**
 * macOS sandbox-exec backend.
 *
 * Uses Apple's Sandbox Profile Language (SBPL) passed inline via `-p`.
 * sandbox-exec is deprecated as of macOS 12 but still functional.
 *
 * Profile strategy:
 *   - Allow all reads by default (matches bwrap behaviour)
 *   - Deny writes globally, then allow specific writable paths
 *   - Network: deny all if no allowed domains, otherwise allow specific domains
 *   - Always allow localhost and Unix domain sockets (needed by many tools)
 */
export class SandboxExecBackend implements SandboxBackend {
  readonly name = 'sandbox-exec';

  isAvailable(): boolean {
    return process.platform === 'darwin';
  }

  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand {
    const profile = buildProfile(config);
    const escaped = command.replace(/'/g, "'\\''");

    return {
      executable: 'sandbox-exec',
      args: ['-p', profile, shell, '-c', `'${escaped}'`],
    };
  }
}

// ── SBPL profile builder ──────────────────────────────────────────────────────

function buildProfile(config: SandboxConfig): string {
  const rules: string[] = [
    '(version 1)',
    '(deny default)',

    // Process control — needed for every command
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach*)',

    // Read everything (mirrors bwrap's --ro-bind / /)
    '(allow file-read*)',
  ];

  // Explicit read denials
  for (const p of config.filesystem.denyRead) {
    rules.push(`(deny file-read* (subpath "${p}"))`);
  }

  // Writable paths
  for (const p of config.filesystem.allowWrite) {
    rules.push(`(allow file-write* (subpath "${p}"))`);
  }

  // Explicit write denials (override allowWrite parents)
  for (const p of config.filesystem.denyWrite) {
    rules.push(`(deny file-write* (subpath "${p}"))`);
  }

  // Network
  // Always allow localhost and Unix sockets (needed by npm, git, etc.)
  rules.push('(allow network-outbound (remote unix-socket))');
  rules.push('(allow network-outbound (remote tcp "localhost:*"))');
  rules.push('(allow network-outbound (remote tcp "127.0.0.1:*"))');

  if (config.network.allowedDomains.length === 0) {
    // No allowed domains → full network isolation
    rules.push('(deny network-outbound)');
    rules.push('(deny network-inbound)');
  } else {
    for (const domain of config.network.allowedDomains) {
      // Allow both the domain and its wildcard subdomain form
      rules.push(`(allow network-outbound (remote tcp "${domain}:*"))`);
      rules.push(`(allow network-outbound (remote tcp "*.${domain}:*"))`);
    }
    for (const domain of config.network.deniedDomains) {
      rules.push(`(deny network-outbound (remote tcp "${domain}:*"))`);
      rules.push(`(deny network-outbound (remote tcp "*.${domain}:*"))`);
    }
  }

  return rules.join('\n');
}
