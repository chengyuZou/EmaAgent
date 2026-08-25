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

/** GET /api/workspace/file 返回:文本/图片/过大/二进制 四态 */
export interface FileContentText     { content: string;  encoding: 'text';  mimeType: string; size: number; }
export interface FileContentImage    { content: string;  encoding: 'base64'; mimeType: string; size: number; }
export interface FileContentTooLarge { tooLarge: true;    size: number; limit: number; }
export interface FileContentBinary   { binary: true;      mimeType: string; size: number; }
export type FileContent = FileContentText | FileContentImage | FileContentTooLarge | FileContentBinary;

export const workspaceApi = {
  async ls(dirPath: string): Promise<FileEntry[]> {
    const params = new URLSearchParams({ path: dirPath });
    const data = await sidecarClient.request<{ entries: FileEntry[] }>(
      `/api/workspace/ls?${params.toString()}`,
    );
    return data.entries;
  },

  /** 读文件内容(in-app 预览用)。文本/图片/过大/二进制四态。 */
  async readFile(filePath: string): Promise<FileContent> {
    const params = new URLSearchParams({ path: filePath });
    return sidecarClient.request<FileContent>(`/api/workspace/file?${params.toString()}`);
  },
};
