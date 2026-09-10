// 服务端文件(图片/音频/封面)的统一读取:/api 路由要带共享密钥头,<img>/<audio> 直链会 401,
// 所以先 fetch 成 blob 再转 objectURL;调用方负责 revoke。
import { serverClient } from '../api/client.js';

export async function fetchServerObjectUrl(apiPath: string): Promise<string | null> {
  try {
    const response = await serverClient.requestRaw(apiPath);
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}
