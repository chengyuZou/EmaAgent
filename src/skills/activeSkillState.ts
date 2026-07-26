// 保存单个 Agent 已激活的 Skill 快照，并生成压缩后可重复投递的上下文。
import type {
  ActivatedSkill,
  ActiveSkillStatePort,
  SkillFile,
} from './types.js';

export class ActiveSkillState implements ActiveSkillStatePort {
  private readonly activeById = new Map<string, ActivatedSkill>();

  activate(skill: ActivatedSkill): void {
    const snapshot = cloneActivatedSkill(skill);
    // 重复激活同一 Skill 时，最后一次参数和文件 revision 生效并移动到末尾。
    this.activeById.delete(snapshot.skillId);
    this.activeById.set(snapshot.skillId, snapshot);
  }

  list(): readonly ActivatedSkill[] {
    return Object.freeze([...this.activeById.values()]);
  }

  fork(): ActiveSkillState {
    const forked = new ActiveSkillState();
    for (const skill of this.activeById.values()) forked.activate(skill);
    return forked;
  }
}

/** 把激活状态投影为模型可见上下文；资源只暴露路径与摘要，不读取正文。 */
export function renderActiveSkillContext(
  skills: readonly ActivatedSkill[],
): string | null {
  if (skills.length === 0) return null;

  const sections = skills.map((skill) => {
    const resources = skill.files
      .filter((file) => file.kind !== 'instructions')
      .map((file) => renderFile(file))
      .join('\n');
    const resourceBlock = resources
      ? `\n<skill-resources>\n${resources}\n</skill-resources>`
      : '';
    return [
      `<active-skill name="${escapeAttribute(skill.name)}"`,
      ` version="${escapeAttribute(skill.version)}"`,
      ` path="${escapeAttribute(skill.path)}"`,
      ` bundle-revision="${escapeAttribute(skill.bundleRevision)}">`,
      skill.instructions,
      resourceBlock,
      '</active-skill>',
    ].join('');
  });

  return [
    '<active-skills>',
    '以下 Skill 来自用户启用的本地文件。按其指令完成当前工作，但脚本仍须通过工具、权限与沙箱执行。',
    ...sections,
    '</active-skills>',
  ].join('\n');
}

function renderFile(file: SkillFile): string {
  return `- ${file.kind}: ${file.relativePath} (${file.path})`;
}

function cloneActivatedSkill(skill: ActivatedSkill): ActivatedSkill {
  return Object.freeze({
    ...skill,
    allowedToolPatterns: Object.freeze([...skill.allowedToolPatterns]),
    files: Object.freeze(skill.files.map((file) => Object.freeze({ ...file }))),
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
