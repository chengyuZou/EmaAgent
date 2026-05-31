// ── Live2D runtime model configuration ──────────────────────────────────────
//
// Character cards expose semantic emotion/motion labels such as "happy" or
// "wave". Live2D models expose concrete resource names such as "liulei" or
// the "Idle" motion group. This config is the boundary between the two.

export interface Live2DMotionTarget {
  group: string;
  index?: number;
}

export interface Live2DStageTarget {
  expression?: string;
  motion?: Live2DMotionTarget;
  durationSec?: number;
}

export interface Live2DParameterRuntimeConfig {
  mouthOpenParam: string;
  mouthOpenMax: number;
  speechNodParam?: string;
  speechNodAmplitude: number;
  headInputX: string;
  headInputY: string;
  headInputZ: string;
  breathParam: string;
}

export interface Live2DIdleBeatRuntimeConfig {
  swayAmplitude: number;
  swayFrequencyX: number;
  swayFrequencyY: number;
  swayFrequencyZ: number;
  breathFrequency: number;
}

export interface Live2DRandomIdleRuntimeConfig {
  group: string;
  minDelayMs: number;
  maxDelayMs: number;
}

export interface Live2DModelRuntimeConfig {
  modelId?: string;
  emotionMap?: Record<string, Live2DStageTarget>;
  motionMap?: Record<string, Live2DMotionTarget>;
  parameters?: Partial<Live2DParameterRuntimeConfig>;
  idleBeat?: Partial<Live2DIdleBeatRuntimeConfig>;
  randomIdle?: Partial<Live2DRandomIdleRuntimeConfig>;
}

export interface ResolvedLive2DModelRuntimeConfig {
  modelId: string;
  emotionMap: Record<string, Live2DStageTarget>;
  motionMap: Record<string, Live2DMotionTarget>;
  parameters: Live2DParameterRuntimeConfig;
  idleBeat: Live2DIdleBeatRuntimeConfig;
  randomIdle: Live2DRandomIdleRuntimeConfig;
}

export const DEFAULT_LIVE2D_RUNTIME_CONFIG: ResolvedLive2DModelRuntimeConfig = {
  modelId: 'unknown',
  emotionMap: {},
  motionMap: {},
  parameters: {
    mouthOpenParam: 'ParamMouthOpenY',
    mouthOpenMax: 1,
    speechNodParam: undefined,
    speechNodAmplitude: 0,
    headInputX: 'ParamAngleX',
    headInputY: 'ParamAngleY',
    headInputZ: 'ParamAngleZ',
    breathParam: 'ParamBreath',
  },
  idleBeat: {
    swayAmplitude: 10,
    swayFrequencyX: 0.8,
    swayFrequencyY: 0.56,
    swayFrequencyZ: 0.62,
    breathFrequency: 0.6,
  },
  randomIdle: {
    group: 'Idle',
    minDelayMs: 12_000,
    maxDelayMs: 35_000,
  },
};

export function resolveLive2DModelRuntimeConfig(
  config?: Live2DModelRuntimeConfig,
): ResolvedLive2DModelRuntimeConfig {
  return {
    modelId: config?.modelId ?? DEFAULT_LIVE2D_RUNTIME_CONFIG.modelId,
    emotionMap: { ...DEFAULT_LIVE2D_RUNTIME_CONFIG.emotionMap, ...config?.emotionMap },
    motionMap: { ...DEFAULT_LIVE2D_RUNTIME_CONFIG.motionMap, ...config?.motionMap },
    parameters: {
      ...DEFAULT_LIVE2D_RUNTIME_CONFIG.parameters,
      ...config?.parameters,
    },
    idleBeat: {
      ...DEFAULT_LIVE2D_RUNTIME_CONFIG.idleBeat,
      ...config?.idleBeat,
    },
    randomIdle: {
      ...DEFAULT_LIVE2D_RUNTIME_CONFIG.randomIdle,
      ...config?.randomIdle,
    },
  };
}
