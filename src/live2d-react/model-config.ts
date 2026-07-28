// 定义并校验角色语义到 Live2D 模型参数、动作与待机行为的运行配置。
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
  /**
   * 独立身体转动输入参数(模型能力,可选)。缺省表示身体跟随头部经物理派生,
   * 设置页不渲染身体滑块、head-pose 不写入;仅当模型物理上支持直写
   * (参数未被 physics3.json Output 覆写)时才由角色卡声明。
   */
  bodyInputX?: string;
  bodyInputY?: string;
  bodyInputZ?: string;
  breathParam: string;
  eyeLOpenParam: string;
  eyeROpenParam: string;
  eyeBallXParam: string;
  eyeBallYParam: string;
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
    bodyInputX: undefined,
    bodyInputY: undefined,
    bodyInputZ: undefined,
    breathParam: 'ParamBreath',
    eyeLOpenParam: 'ParamEyeLOpen',
    eyeROpenParam: 'ParamEyeROpen',
    eyeBallXParam: 'ParamEyeBallX',
    eyeBallYParam: 'ParamEyeBallY',
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

const MIN_RANDOM_IDLE_DELAY_MS = 1_000;
const MAX_RANDOM_IDLE_DELAY_MS = 24 * 60 * 60 * 1_000;

export function resolveLive2DModelRuntimeConfig(
  config?: Live2DModelRuntimeConfig,
): ResolvedLive2DModelRuntimeConfig {
  const defaults = DEFAULT_LIVE2D_RUNTIME_CONFIG;
  const minDelayMs = finiteNumber(
    config?.randomIdle?.minDelayMs,
    defaults.randomIdle.minDelayMs,
    MIN_RANDOM_IDLE_DELAY_MS,
    MAX_RANDOM_IDLE_DELAY_MS,
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    finiteNumber(
      config?.randomIdle?.maxDelayMs,
      defaults.randomIdle.maxDelayMs,
      MIN_RANDOM_IDLE_DELAY_MS,
      MAX_RANDOM_IDLE_DELAY_MS,
    ),
  );

  return {
    modelId: nonEmptyString(config?.modelId, defaults.modelId),
    emotionMap: { ...defaults.emotionMap, ...config?.emotionMap },
    motionMap: { ...defaults.motionMap, ...config?.motionMap },
    parameters: {
      mouthOpenParam: nonEmptyString(
        config?.parameters?.mouthOpenParam,
        defaults.parameters.mouthOpenParam,
      ),
      mouthOpenMax: finiteNumber(
        config?.parameters?.mouthOpenMax,
        defaults.parameters.mouthOpenMax,
        0,
        10,
      ),
      speechNodParam: optionalNonEmptyString(config?.parameters?.speechNodParam),
      speechNodAmplitude: finiteNumber(
        config?.parameters?.speechNodAmplitude,
        defaults.parameters.speechNodAmplitude,
        0,
        30,
      ),
      headInputX: nonEmptyString(config?.parameters?.headInputX, defaults.parameters.headInputX),
      headInputY: nonEmptyString(config?.parameters?.headInputY, defaults.parameters.headInputY),
      headInputZ: nonEmptyString(config?.parameters?.headInputZ, defaults.parameters.headInputZ),
      bodyInputX: optionalNonEmptyString(config?.parameters?.bodyInputX),
      bodyInputY: optionalNonEmptyString(config?.parameters?.bodyInputY),
      bodyInputZ: optionalNonEmptyString(config?.parameters?.bodyInputZ),
      breathParam: nonEmptyString(config?.parameters?.breathParam, defaults.parameters.breathParam),
      eyeLOpenParam: nonEmptyString(config?.parameters?.eyeLOpenParam, defaults.parameters.eyeLOpenParam),
      eyeROpenParam: nonEmptyString(config?.parameters?.eyeROpenParam, defaults.parameters.eyeROpenParam),
      eyeBallXParam: nonEmptyString(config?.parameters?.eyeBallXParam, defaults.parameters.eyeBallXParam),
      eyeBallYParam: nonEmptyString(config?.parameters?.eyeBallYParam, defaults.parameters.eyeBallYParam),
    },
    idleBeat: {
      swayAmplitude: finiteNumber(config?.idleBeat?.swayAmplitude, defaults.idleBeat.swayAmplitude, 0, 30),
      swayFrequencyX: finiteNumber(config?.idleBeat?.swayFrequencyX, defaults.idleBeat.swayFrequencyX, 0, 10),
      swayFrequencyY: finiteNumber(config?.idleBeat?.swayFrequencyY, defaults.idleBeat.swayFrequencyY, 0, 10),
      swayFrequencyZ: finiteNumber(config?.idleBeat?.swayFrequencyZ, defaults.idleBeat.swayFrequencyZ, 0, 10),
      breathFrequency: finiteNumber(config?.idleBeat?.breathFrequency, defaults.idleBeat.breathFrequency, 0, 10),
    },
    randomIdle: {
      group: nonEmptyString(config?.randomIdle?.group, defaults.randomIdle.group),
      minDelayMs,
      maxDelayMs,
    },
  };
}

/** modelId 决定表情默认值的持久化命名空间，变化时必须重建模型运行实例。 */
export function live2DReloadConfigKey(config?: Live2DModelRuntimeConfig): string {
  return resolveLive2DModelRuntimeConfig(config).modelId;
}

function finiteNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function nonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
