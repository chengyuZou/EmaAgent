/**
 * Workspace API — file system browsing for the Files inspector panel.
 * GET /api/workspace/ls?path=<absolute path>
 */
import { sidecarClient } from './sidecar-client.js';

export interface FileEntry {
  name:  string;
  path:  string;
  type:  'file' | 'dir';
  size?: number;
}

export const workspaceApi = {
  async ls(dirPath: string): Promise<FileEntry[]> {
    const params = new URLSearchParams({ path: dirPath });
    const data = await sidecarClient.request<{ entries: FileEntry[] }>(
      `/api/workspace/ls?${params.toString()}`,
    );
    return data.entries;
  },
};
