// 把设置页的头/身转动滑块基准值以幂等加算合成到模型的转动输入参数上。
//
// Final-stage 插件,注册在 idle-beat 之后、lipsync 之前,组成 set-then-add 链:
//   idle-beat(final, SET sway) → user-pose(加算滑块基准) → lipsync(加算 speechNod)
//
// 头部三元始终写入 parameters.headInputX/Y/Z(Ema = Param85/86/87 输入参数,
// 标准模型默认为 ParamAngleX/Y/Z);身体三元仅在角色卡声明 bodyInputX/Y/Z 时
// 写入——Ema 的身体角度是 physics 输出,直写会被覆写,故不声明即不出现。
//
// 加算必须 remember-and-subtract(先撤回自己上一帧的贡献再加新值):
// 裸加算(current + offset)在上游没有每帧重设参数时(如 idleBeat 关闭)会逐帧
// 累加直至卡死上限;撤回式写法则与上游是否写入完全解耦,每帧净效果恒等于滑块值。
import type { MotionPlugin, MotionPluginContext } from './motion-manager.js';
import type { Live2DParameterRuntimeConfig } from '../model-config.js';

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

export function createUserPosePlugin(
  readPose: () => Live2DPoseSnapshot,
  readParameters: () => Live2DParameterRuntimeConfig,
): MotionPlugin {
  // 本插件对每个参数的当前贡献;帧间先撤后加,与上游写入方解耦。
  const added = new Map<string, number>();

  function apply(ctx: MotionPluginContext, param: string, value: number): void {
    const clamped = Math.max(-POSE_LIMIT, Math.min(POSE_LIMIT, value));
    const current = ctx.model.getParameterValueById(param);
    ctx.model.setParameterValueById(param, current - (added.get(param) ?? 0) + clamped);
    added.set(param, clamped);
  }

  return (ctx) => {
    const pose = readPose();
    const params = readParameters();
    apply(ctx, params.headInputX, pose.angleX);
    apply(ctx, params.headInputY, pose.angleY);
    apply(ctx, params.headInputZ, pose.angleZ);
    // 独立身体转动是模型能力:仅在角色卡声明 bodyInput* 时写入。
    if (params.bodyInputX && params.bodyInputY && params.bodyInputZ) {
      apply(ctx, params.bodyInputX, pose.bodyAngleX);
      apply(ctx, params.bodyInputY, pose.bodyAngleY);
      apply(ctx, params.bodyInputZ, pose.bodyAngleZ);
    }
  };
}
