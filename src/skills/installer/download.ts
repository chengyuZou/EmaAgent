// 技能包下载:原生 fetch + sha256 校验。只产出字节,不解压不落盘。
import { createHash } from 'node:crypto';

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** 响应体上限;给足余量,不做业务限量。 */
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export interface BundleDownloadInput {
  readonly bundleUrl: string;
  readonly bundleSha256: string;
  /** 站点索引声明的体积;实收不符视为索引被篡改。 */
  readonly sizeBytes?: number;
}

export async function downloadBundle(input: BundleDownloadInput): Promise<Uint8Array> {
  const response = await fetch(input.bundleUrl, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`技能包下载失败(HTTP ${response.status}): ${input.bundleUrl}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > DOWNLOAD_MAX_BYTES) {
    throw new Error(`技能包体积超过 ${DOWNLOAD_MAX_BYTES} 字节上限`);
  }
  if (input.sizeBytes !== undefined && bytes.byteLength !== input.sizeBytes) {
    throw new Error(
      `技能包体积与索引声明不符(${bytes.byteLength} != ${input.sizeBytes}),索引可能被篡改`,
    );
  }
  const digest = sha256Hex(bytes);
  if (digest !== input.bundleSha256.toLowerCase()) {
    throw new Error('技能包 sha256 校验失败,内容可能被篡改');
  }
  return bytes;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
