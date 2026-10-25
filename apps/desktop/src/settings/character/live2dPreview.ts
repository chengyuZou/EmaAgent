// 角色设置中的静态封面: 用一次性的 Pixi Application 渲一帧, 裁掉透明边并补成 3:4.
// 不使用舞台的持续渲染循环, 完成后销毁模型和 Canvas.
import * as PIXI from 'pixi.js';
import { loadLive2DArchive } from '@ema-agent/live2d-react';
import cropEmptyPixels from '@lemonneko/crop-empty-pixels';

/** 用模型 ZIP 离屏渲一帧,返回 3:4 的 PNG base64(不带 dataURL 前缀). */
export async function renderLive2dPreview(modelArchive: Blob): Promise<string> {
  const width = 3072;
  const height = 4096;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.opacity = '0';
  canvas.style.position = 'fixed';
  canvas.style.pointerEvents = 'none';
  document.body.appendChild(canvas);

  let app: PIXI.Application | null = null;
  let initialized = false;
  let model: Awaited<ReturnType<typeof loadLive2DArchive>> | null = null;
  try {
    app = new PIXI.Application();
    await app.init({
      canvas,
      width,
      height,
      backgroundAlpha: 0,
      autoStart: false,
      // 截图在 render 后读取 Canvas, 需要保留这一帧的 WebGL 缓冲区.
      preserveDrawingBuffer: true,
      preference: 'webgl',
      preferWebGLVersion: 2,
    });
    initialized = true;
    model = await loadLive2DArchive(modelArchive, {
      ticker: app.ticker,
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: false,
      // 封面只抓固定初始化帧;若启动模型 Idle,抓图结果会随随机 Motion 和时机变化.
      idleMotionGroup: '__ema_idle_disabled__',
    });
    const bounds = model.getBounds();
    const scale = Math.min(width / bounds.width, height / bounds.height) * 0.9;
    model.scale.set(scale);
    // bounds.x/y 是模型自身坐标系的原点偏移
    model.position.set(
      width / 2 - (bounds.x + bounds.width / 2) * scale,
      height / 2 - (bounds.y + bounds.height / 2) * scale,
    );
    app.stage.addChild(model);
    // autoUpdate 关闭后等待不会推进模型.必须先注入一帧时间,让 Cubism Pose 初始化
    // 互斥部件的透明度;否则带备用手臂/服装的模型会把所有部件一起画进封面.
    model.update(1000 / 60);
    app.renderer.render({ container: app.stage });

    const dataUrl = canvas.toDataURL('image/png');
    const cropped = await cropToAspect(dataUrl, width, height);
    return cropped.slice(cropped.indexOf(',') + 1);
  } finally {
    if (app && model) {
      app.stage.removeChild(model);
      // Pixi 会先销毁 Application ticker,再销毁 stage 子节点;Live2D 模型销毁时还要
      // 从 ticker 解绑.顺序倒置会让 Ticker.remove() 读取已清空的链表头并抛出 .next 错误.
      model.destroy({ children: true, texture: true, baseTexture: true });
    }
    if (initialized) app?.destroy(true);
    canvas.remove();
  }
}

/**
 * 把渲出的帧裁成 3:4 卡面图.
 * 帧的角色四周是一圈透明像素:cropEmptyPixels 按 alpha 找到内容包围盒裁掉,
 * 然后我们把内容等比放大, 居中画进干净的 3:4 画布.
 * 裁剪结果为空或与原帧相同时直接返回原图.
 */
async function cropToAspect(dataUrl: string, width: number, height: number): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('预览帧读取失败'));
    img.src = dataUrl;
  });
  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  frame.getContext('2d')!.drawImage(image, 0, 0);

  const cropped = cropEmptyPixels(frame);
  const isEmpty = cropped.width === 0 || cropped.height === 0
    || (cropped.width === width && cropped.height === height
      && frame.toDataURL() === cropped.toDataURL());
  if (isEmpty) return dataUrl;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d')!;
  const fit = Math.min(width / cropped.width, height / cropped.height);
  const drawW = cropped.width * fit;
  const drawH = cropped.height * fit;
  outCtx.drawImage(
    cropped,
    (width - drawW) / 2, (height - drawH) / 2, drawW, drawH,
  );
  return out.toDataURL('image/png');
}
