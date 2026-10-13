import { serverClient } from './client.js';

/** 读取受认证保护的文件并创建 Object URL; 调用方在不再使用时负责 revoke. */
export async function fetchServerObjectUrl(apiPath: string): Promise<string | null> {
  try {
    const response = await serverClient.requestRaw(apiPath);
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}
