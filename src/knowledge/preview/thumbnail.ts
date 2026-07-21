const W = 320, H = 240;

export async function imageThumbnail(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const sharp = (await import('sharp')).default;
    const buf   = await sharp(Buffer.from(bytes))
      .resize(W, H, { fit: 'inside', withoutEnlargement: true })
      .png().toBuffer();
    return new Uint8Array(buf);
  } catch { return undefined; }
}

export async function pdfThumbnail(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const { createCanvas } = await import('canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf   = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
    const page  = await pdf.getPage(1);
    const vp    = page.getViewport({ scale: 1 });
    const scale = Math.min(W / vp.width, H / vp.height);
    const sv    = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(sv.width), Math.round(sv.height));
    await page.render({ canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport: sv }).promise;
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch { return undefined; }
}
