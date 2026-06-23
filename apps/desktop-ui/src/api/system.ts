import { sidecarClient } from './sidecar-client.js';

export interface DiskInfoWire {
  mount: string;
  label: string;
  total: number;
  free:  number;
}

export interface SystemInfoWire {
  disks:   DiskInfoWire[];
  dataDir: string;
}

export const systemApi = {
  getInfo(): Promise<SystemInfoWire> {
    return sidecarClient.request<SystemInfoWire>('/api/system/disks');
  },
};
