// 动态取色: 从当前角色封面立绘采样主色, 提取 oklch 色相.
// 只在 hueDynamic 开启时被调用; 采样失败一律回退手动色相(返回 null).
import { useCharacterStore } from '../stores/character.js';
import { charactersApi } from '../api/characters.js';
import { fetchServerObjectUrl } from './serverFileUrl.js';
import { srgbToOklch } from './oklch.js';

export async function sampleActiveCharacterHue(): Promise<number | null> {
  const state = useCharacterStore.getState();
  const character = state.characters.find(item => item.name === state.activeName);
  if (!character?.coverResourceName) return null;
  try {
    const url = await fetchServerObjectUrl(
      charactersApi.illustrationFileUrl(character.name, character.coverResourceName),
    );
    if (!url) return null;
    return await sampleImageHue(url);
  } catch {
    return null;
  }
}

/* 48px 缩样 + 饱和度加权平均; 透明与无彩色(灰白黑)像素不参与, 它们不是"主色". */
async function sampleImageHue(url: string): Promise<number | null> {
  const image = await loadImage(url);
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = (data[i + 3] ?? 0) / 255;
    if (alpha < 0.2) continue;
    const pr = (data[i] ?? 0) / 255;
    const pg = (data[i + 1] ?? 0) / 255;
    const pb = (data[i + 2] ?? 0) / 255;
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < 0.12) continue;
    const w = alpha * saturation;
    r += pr * w;
    g += pg * w;
    b += pb * w;
    weight += w;
  }
  if (weight === 0) return null;
  return Math.round(srgbToOklch(r / weight, g / weight, b / weight).h);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image load failed'));
    image.src = url;
  });
}
