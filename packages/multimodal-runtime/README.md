# @ema-agent/multimodal-runtime

## 一句话职责

视觉单帧分析、图库管理、STT/TTS 占位。只分析媒体，不管理记忆。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— VisionMemoryBlock、多模态相关类型
- `@ema-agent/constants-core` —— 多模态相关常量

## 下游消费者（谁可以 import 我）

- `@ema-agent/memory-runtime` —— 将视觉分析结果纳入记忆召回
- `@ema-agent/orchestrator-runtime` —— 视觉模式调用

## 对外接口

- `export interface VisionAnalyzer` —— 视觉分析器接口
- `export function analyzeFrame()` —— 单帧图像分析
- `export function buildVisionGallery()` —— 图库聚合描述
- `export interface STTService`、`TTSService` —— 语音占位接口

## 禁止事项

- ❌ 禁止 import `memory-runtime`（应由 memory 消费 multimodal 的结果，而不是反过来）
- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止在分析器里写入记忆存储
- ❌ 视频处理不在 V1 范围内（只做单帧）
