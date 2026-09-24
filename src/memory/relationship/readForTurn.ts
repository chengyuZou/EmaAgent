// 为一次 Turn 读取当前角色可见的正式关系记忆

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function readRelationshipMemoryForTurn(
  memoryDirectory: string,
  characterName: string,
): Promise<string | undefined> {
  const [shared, character, relations] = await Promise.all([
    readFile(path.join(memoryDirectory, 'shared_user_memory.md')),
    readFile(path.join(memoryDirectory, 'characters', characterName, 'MEMORY.md')),
    readFile(path.join(memoryDirectory, 'character_relations.md')),
  ]);
  const sections: string[] = [];
  if (shared?.trim()) sections.push(`### 共享用户记忆\n${shared.trim()}`);
  if (character?.trim()) sections.push(`### 当前角色记忆- ${characterName}\n${character.trim()}`);
  if (relations) {
    const matchingSections = relations
      .split(/(?=^##[ \t]+)/m)
      .filter(section => /^##[ \t]+/.test(section) && section.includes(characterName))
      .map(section => section.trim());
    if (matchingSections.length > 0) {
      sections.push(`### 与当前角色有关的角色关系\n${matchingSections.join('\n\n')}`);
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

async function readFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
