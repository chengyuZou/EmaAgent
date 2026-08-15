// 定义全局激活角色发生变化时公开的角色业务事件。

export interface CharacterCardSwitchedEvent {
  type: 'character_card_switched';
  cardId: string;
  name: string;
}

export interface CharacterPresentationChangedEvent {
  type: 'character_presentation_changed';
  cardId: string;
}

export type CharacterEvent =
  | CharacterCardSwitchedEvent
  | CharacterPresentationChangedEvent;
