import { sidecarClient } from './sidecar-client.js';

export type ShellStatus =
  | { available: true;  path: string }
  | { available: false; wingetAvailable: boolean; wslAvailable: boolean };

export interface GitInstallResult {
  ok:  boolean;
  log: string;
}

export const shellApi = {
  status(fresh = false): Promise<ShellStatus> {
    const path = fresh ? '/api/system/shell?fresh=1' : '/api/system/shell';
    return sidecarClient.request<ShellStatus>(path);
  },

  installGit(): Promise<GitInstallResult> {
    return sidecarClient.request<GitInstallResult>('/api/system/shell/install-git', {
      method: 'POST',
    });
  },
};
