// Live2D 卡面/角色封面的静态图:导入流程或用户手动重试时,把模型装进一次性离屏
// Pixi Application,渲一帧、裁透明边、补成 3:4,渲完即毁。不持有第二份活 Canvas。
import * as PIXI from 'pixi.js';
import { loadLive2DArchive } from '@ema-agent/live2d-react';
import cropEmptyPixels from '@lemonneko/crop-empty-pixels';

/** 用模型 ZIP 离屏渲一帧,返回 3:4 的 PNG base64(不带 dataURL 前缀)。 */
export async function renderLive2dPreview(modelArchive: Blob): Promise<string> {
  const width = 480;
  const height = 640;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.opacity = '0';
  canvas.style.position = 'fixed';
  canvas.style.pointerEvents = 'none';
  document.body.appendChild(canvas);

  let app: PIXI.Application | null = null;
  let model: Awaited<ReturnType<typeof loadLive2DArchive>> | null = null;
  try {
    // 手工建一个 canvas 元素挂进 DOM
    // 它在页面上"存在但不可见"
    app = new PIXI.Application({
      view: canvas,
      width,
      height,
      // 背景全透明
      backgroundAlpha: 0,
      // 不开渲染循环
      autoStart: false,
      // 默认渲完 WebGL 缓冲区就清
      preserveDrawingBuffer: true,
    });
    model = await loadLive2DArchive(modelArchive, {
      ticker: app.ticker,
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: false,
      idleMotionGroup: '__ema_idle_disabled__',
    });
    // 摆位:模型居中铺满高度
    const bounds = model.getBounds();
    const scale = Math.min(width / bounds.width, height / bounds.height) * 0.9;
    model.scale.set(scale);
    // bounds.x/y 是模型自身坐标系的原点偏移
    model.position.set(
      width / 2 - (bounds.x + bounds.width / 2) * scale,
      height / 2 - (bounds.y + bounds.height / 2) * scale,
    );
    app.stage.addChild(model);
    // autoUpdate 关闭后等待不会推进模型。必须先注入一帧时间,让 Cubism Pose 初始化
    // 互斥部件的透明度;否则带备用手臂/服装的模型会把所有部件一起画进封面。
    model.update(1000 / 60);
    app.renderer.render(app.stage);

    const dataUrl = app.renderer.view.toDataURL?.('image/png')
      ?? (app.view as HTMLCanvasElement).toDataURL('image/png');
    const cropped = await cropToAspect(dataUrl, width, height);
    return cropped.slice(cropped.indexOf(',') + 1);
  } finally {
    if (app && model) {
      app.stage.removeChild(model);
      // Pixi 会先销毁 Application ticker,再销毁 stage 子节点;Live2D 模型销毁时还要
      // 从 ticker 解绑。顺序倒置会让 Ticker.remove() 读取已清空的链表头并抛出 .next 错误。
      model.destroy({ children: true, texture: true, baseTexture: true });
    }
    app?.destroy(true);
    canvas.remove();
  }
}

/**
 * 把渲出的帧裁成 3:4 卡面图。
 * 帧的角色四周是一圈透明像素:cropEmptyPixels 按 alpha 找到内容包围盒裁掉,
 * 然后我们把内容等比放大、居中画进干净的 3:4 画布。
 * 源帧全透明时(模型没渲出来)原样返回——宁可给空帧也不给错位的图。
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
