// 集中声明真正影响产品可用性的角色资源上限。

export const CHARACTER_RESOURCE_LIMITS = Object.freeze({
  live2dRuntimeConfigBytes: 1024 * 1024,
  illustrationBytes: 20 * 1024 * 1024,
  voiceBytes: 25 * 1024 * 1024,
  voiceDurationMs: 10 * 60 * 1_000,
});
