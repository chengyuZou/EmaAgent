// 边界: 本包只服务不可信来源发起的流量(LLM 工具调用/市场下载);
// 用户配置的 provider 端点(GPT-SoVITS/STT/TTS/MCP/Bridge)不经过本包,
// 私网/内网端点是用户的合法环境, 不得套用本包的公网检查.
export {
  PublicHttpLimitError,
  PublicHttpPolicyError,
  PublicHttpStatusError,
} from './errors.js';
export {
  approvePublicTarget,
  assertSafePublicRedirect,
  isObviouslyUnsafePublicUrl,
  isPublicNetworkAddress,
} from './url-policy.js';
export { fetchPublicResource } from './client.js';
export type {
  ApprovedPublicTarget,
  PublicHttpRequestOptions,
  PublicHttpResponse,
} from './types.js';
