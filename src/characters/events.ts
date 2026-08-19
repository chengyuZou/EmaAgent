// 定义全局激活角色发生变化时公开的角色业务事件。

export interface CharacterSwitchedEvent {
  type: 'character_switched';
  characterId: string;
  name: string;
}

export interface CharacterPresentationChangedEvent {
  type: 'character_presentation_changed';
  characterId: string;
}

export type CharacterEvent =
  | CharacterSwitchedEvent
  | CharacterPresentationChangedEvent;
