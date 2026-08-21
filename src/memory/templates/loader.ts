// 按需模板加载器:模板是 md 资产(不是 TS 常量),构建时由
// scripts/copy-templates.mjs 复制到 dist/templates,运行时从这里以 UTF-8
// 读取。按需加载:要哪个 key 就只读那个文件,单 key 缓存,不一次性全读。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 内置模板集(全部 key):两条提取轨(work/relationship 各 system+input)、
 * 两条整合轨(work/relationship 各 consolidation)、记忆使用指引(memoryGuidance)。
 * 应用层可整体或按轨覆盖。
 */
export interface ExtractionTemplates {
  readonly workSystem: string;
  readonly workInput: string;
  readonly relationshipSystem: string;
  readonly relationshipInput: string;
  readonly workConsolidation: string;
  readonly relationshipConsolidation: string;
  readonly memoryGuidance: string;
}

// loader 位于 dist/templates 内,md 与之同级目录。
const TEMPLATE_DIR = fileURLToPath(new URL('.', import.meta.url));

const TEMPLATE_FILES: Readonly<Record<keyof ExtractionTemplates, string>> = {
  workSystem: 'work/extractionSystem.md',
  workInput: 'work/extractionInput.md',
  relationshipSystem: 'relationship/extractionSystem.md',
  relationshipInput: 'relationship/extractionInput.md',
  workConsolidation: 'work/consolidation.md',
  relationshipConsolidation: 'relationship/consolidation.md',
  memoryGuidance: 'memoryGuidance.md',
};

const templateCache = new Map<keyof ExtractionTemplates, Promise<string>>();

/** 按需读取单个模板(UTF-8);同 key 只读一次,失败后允许重试。 */
export function loadTemplate(key: keyof ExtractionTemplates): Promise<string> {
  let pending = templateCache.get(key);
  if (!pending) {
    pending = readFile(path.join(TEMPLATE_DIR, TEMPLATE_FILES[key]), 'utf8');
    templateCache.set(key, pending);
    void pending.catch(() => {
      templateCache.delete(key);
    });
  }
  return pending;
}
