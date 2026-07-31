// 定义全局激活角色发生变化时公开的角色业务事件。
import type { CharacterCardId } from '@ema-agent/ids';

export interface CharacterCardSwitchedEvent {
  type: 'character_card_switched';
  cardId: CharacterCardId;
  name: string;
}

export interface CharacterPresentationChangedEvent {
  type: 'character_presentation_changed';
  cardId: CharacterCardId;
}

export type CharacterEvent =
  | CharacterCardSwitchedEvent
  | CharacterPresentationChangedEvent;
