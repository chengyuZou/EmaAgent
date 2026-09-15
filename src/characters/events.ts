// 定义全局激活角色发生变化时公开的角色业务事件。

export interface CharacterSwitchedEvent {
  type: 'character_switched';
  characterName: string;
  displayName: string | null;
}

export interface CharacterPresentationChangedEvent {
  /** 只有主舞台读取结果可能变化时才发送,普通资源和封面变化不能重载主 Canvas。 */
  type: 'character_presentation_changed';
  characterName: string;
}

export interface CharacterResourcesChangedEvent {
  /** 角色包中的资源已经完成写入,Settings 收到后可以重新读取列表和文件。 */
  type: 'character_resources_changed';
  characterName: string;
}

export type CharacterEvent =
  | CharacterSwitchedEvent
  | CharacterResourcesChangedEvent
  | CharacterPresentationChangedEvent;
