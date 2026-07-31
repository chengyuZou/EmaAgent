// 集中声明角色资源的安全上限，校验器与导入流程共享同一套口径。

export const CHARACTER_RESOURCE_LIMITS = Object.freeze({
  // 输入端放宽到 50MB:用户可能直接导入未压缩原图,normalizer 会重编码压回输出上限。
  portraitInputBytes: 50 * 1024 * 1024,
  portraitOutputBytes: 20 * 1024 * 1024,
  portraitEdge: 8_192,
  portraitPixels: 40_000_000,
  voiceBytes: 25 * 1024 * 1024,
  voiceDurationMs: 10 * 60 * 1_000,
  live2dFiles: 2_048,
  live2dSingleFileBytes: 128 * 1024 * 1024,
  // 整目录 1.5G:重模型(4K 纹理+大量动作)合法,再大基本是多模型打包,内测按用户拍板放行。
  live2dTotalBytes: 1536 * 1024 * 1024,
  live2dManifestBytes: 20 * 1024 * 1024,
  live2dTextures: 64,
  live2dTextureEdge: 8_192,
});
