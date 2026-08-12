// 测试 attachment_ref 的穷尽投影：每个分支都产出模型可见内容，不允许静默丢块。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asAttachmentId, asSessionId, asTurnId, type AttachmentId } from '@ema-agent/ids';
import { resolveAttachmentReferences } from '../modelContent.js';
import type { Attachment, ImageAttachment } from '../types.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'ema-att-proj-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sessionId = asSessionId('s1');
const turnId = asTurnId('t1');

function fileAttachment(id: string): Attachment {
  return {
    id: asAttachmentId(id), turnId, sessionId, kind: 'file',
    name: 'report.pdf', mimeType: 'application/pdf',
    sourcePath: 'D:\\docs\\report.pdf', byteSize: 100, sourceModifiedAt: 1, createdAt: 1,
  };
}

function imageAttachment(id: string): Attachment {
  const imagePath = path.join(dir, `${id}.png`);
  writeFileSync(imagePath, Buffer.from([9, 8, 7]));
  return {
    id: asAttachmentId(id), turnId, sessionId, kind: 'image',
    name: 'photo.png', mimeType: 'image/png',
    sourcePath: 'D:\\pics\\photo.png', sourceByteSize: 3, sourceModifiedAt: 1,
    imagePath, imageByteSize: 3, createdAt: 1,
  };
}

function mapOf(...attachments: Attachment[]): ReadonlyMap<AttachmentId, Attachment> {
  return new Map(attachments.map((a) => [a.id, a]));
}

const ref = (id: string) => ({ type: 'attachment_ref' as const, attachmentId: id });

describe('resolveAttachmentReferences', () => {
  it('text 与 tool_result 原样透传，file 投影为路径文本', async () => {
    const out = await resolveAttachmentReferences([
      { type: 'text', text: '看这个' },
      ref('f1'),
    ], mapOf(fileAttachment('f1')), { supportsImageInput: false });

    expect(out[0]).toEqual({ type: 'text', text: '看这个' });
    expect(out[1]).toEqual({
      type: 'text',
      text: '[附件：report.pdf，路径：D:\\docs\\report.pdf]',
    });
  });

  it('模型支持图片时读取受管副本为 image_data', async () => {
    const out = await resolveAttachmentReferences(
      [ref('i1')],
      mapOf(imageAttachment('i1')),
      { supportsImageInput: true },
    );
    expect(out[0]).toEqual({
      type: 'image_data',
      data: Buffer.from([9, 8, 7]).toString('base64'),
      mimeType: 'image/png',
      name: 'photo.png',
    });
  });

  it('模型不支持图片时走 Vision 描述；未配置描述入口时给说明文本', async () => {
    const attachments = mapOf(imageAttachment('i1'));
    const described = await resolveAttachmentReferences([ref('i1')], attachments, {
      supportsImageInput: false,
      describeImage: async (image: ImageAttachment) => `描述:${image.name}`,
    });
    expect(described[0]).toEqual({
      type: 'text',
      text: '[图片附件 photo.png 的描述：描述:photo.png]',
    });

    const fallback = await resolveAttachmentReferences([ref('i1')], attachments, {
      supportsImageInput: false,
    });
    expect(fallback[0]).toEqual({
      type: 'text',
      text: '[图片附件：photo.png（当前模型不支持图片输入）]',
    });
  });

  it('找不到记录、副本读不到、Vision 失败都产出模型可见文本', async () => {
    const missing = await resolveAttachmentReferences(
      [ref('ghost')], mapOf(), { supportsImageInput: true },
    );
    expect(missing[0]).toEqual({ type: 'text', text: '[附件记录已不存在]' });

    const broken = imageAttachment('i2');
    rmSync(broken.imagePath);
    const unreadable = await resolveAttachmentReferences(
      [ref('i2')], mapOf(broken), { supportsImageInput: true },
    );
    expect(unreadable[0]).toEqual({ type: 'text', text: '[附件图片无法读取：photo.png]' });

    const visionFailed = await resolveAttachmentReferences(
      [ref('i1')], mapOf(imageAttachment('i1')), {
        supportsImageInput: false,
        describeImage: async () => { throw new Error('vision down'); },
      },
    );
    expect(visionFailed[0]).toEqual({
      type: 'text',
      text: '[图片附件：photo.png（当前模型不支持图片输入）]',
    });
  });
});
