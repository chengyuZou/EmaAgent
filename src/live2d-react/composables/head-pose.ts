// 头部/身体转动参数的唯一写入方:每帧把 idle 摇摆、设置页滑块姿态与
// 说话点头合成为一个值,纯 SET 到模型的转动输入参数上。
//
//   headInputX/Y/Z(Ema = Param85/86/87,标准模型默认 ParamAngleX/Y/Z)
//   + 可选 bodyInputX/Y/Z(角色卡声明的独立身体转动能力)
//   + 可选 speechNodParam(说话点头;Ema 与 headInputY 同为 Param86)
//   全部由本插件单写。idle 摇摆、滑块、点头不再各自作为独立插件加算——
//   多写入方加算链在"上游是否每帧重设"不确定时必然累积或互相污染,
//   单一写入方纯 SET 是唯一不依赖帧序假设的正确形态。
//
// Final-stage 插件:原生 motion 曲线也可能写输入参数,final 在原生 update
// 之后运行,本插件的值生效。(idle.motion3.json 的 ParamBodyAngle 曲线不影响
// 本插件:身体角度是 physics 输出,每帧被 physics.evaluate 重算覆写。)
import type { MotionPlugin } from './motion-manager.js';
import type { SpeechAnimationStoreApi } from '../stores/speech-store.js';
import type {
  Live2DIdleBeatRuntimeConfig,
  Live2DParameterRuntimeConfig,
} from '../model-config.js';

/** 设置页写入的舞台姿态快照;角度制,范围 ±30(VTube Studio 输入参数约定)。 */
export interface Live2DPoseSnapshot {
  angleX:     number;
  angleY:     number;
  angleZ:     number;
  bodyAngleX: number;
  bodyAngleY: number;
  bodyAngleZ: number;
}

export const NEUTRAL_POSE: Live2DPoseSnapshot = {
  angleX: 0, angleY: 0, angleZ: 0,
  bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0,
};

const POSE_LIMIT = 30;

function clampPose(value: number): number {
  return Math.max(-POSE_LIMIT, Math.min(POSE_LIMIT, value));
}

export function createHeadPosePlugin(opts: {
  readIdleBeatEnabled: () => boolean;
  readPose: () => Live2DPoseSnapshot;
  readParameters: () => Live2DParameterRuntimeConfig;
  readIdleBeat: () => Live2DIdleBeatRuntimeConfig;
  speechStore: SpeechAnimationStoreApi;
  readLipSyncEnabled: () => boolean;
}): MotionPlugin {
  // 摇摆时间轴只在 idleBeat 启用时推进,关闭再开启不会产生相位跳变。
  let activeElapsedMs = 0;

  return (ctx) => {
    const params = opts.readParameters();
    const pose = opts.readPose();

    let swayX = 0;
    let swayY = 0;
    let swayZ = 0;
    if (opts.readIdleBeatEnabled()) {
      activeElapsedMs += ctx.timing.deltaMs;
      const elapsedSec = activeElapsedMs / 1_000;
      const idle = opts.readIdleBeat();
      swayX = idle.swayAmplitude * Math.sin(elapsedSec * idle.swayFrequencyX);
      swayY = idle.swayAmplitude * 0.5 * Math.sin(elapsedSec * idle.swayFrequencyY);
      swayZ = idle.swayAmplitude * 0.3 * Math.sin(elapsedSec * idle.swayFrequencyZ);
      const breath = (Math.sin(elapsedSec * idle.breathFrequency) + 1) * 0.5;
      ctx.model.setParameterValueById(params.breathParam, breath);
    }

    // 说话点头:唇同步关闭或静默时贡献为 0,无需簿记即可自动撤回。
    const { energy } = opts.speechStore.getState();
    const nod = opts.readLipSyncEnabled() && params.speechNodParam && energy > 0.02
      ? energy * params.speechNodAmplitude
      : 0;

    const targets = new Map<string, number>();
    targets.set(params.headInputX, clampPose(swayX + pose.angleX));
    targets.set(params.headInputY, clampPose(swayY + pose.angleY));
    targets.set(params.headInputZ, clampPose(swayZ + pose.angleZ));
    // 独立身体转动是模型能力:仅在角色卡声明 bodyInput* 时写入。
    if (params.bodyInputX && params.bodyInputY && params.bodyInputZ) {
      targets.set(params.bodyInputX, clampPose(pose.bodyAngleX));
      targets.set(params.bodyInputY, clampPose(pose.bodyAngleY));
      targets.set(params.bodyInputZ, clampPose(pose.bodyAngleZ));
    }
    // speechNodParam 与 headInputY 可能是同一参数(Ema 的 Param86):
    // 合并到同一目标值后一次 SET,避免同帧二次写入。
    if (params.speechNodParam && nod !== 0) {
      targets.set(
        params.speechNodParam,
        clampPose((targets.get(params.speechNodParam) ?? 0) + nod),
      );
    }

    for (const [param, value] of targets) {
      ctx.model.setParameterValueById(param, value);
    }
  };
}
