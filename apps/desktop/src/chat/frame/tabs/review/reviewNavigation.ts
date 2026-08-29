// 保存每个 Session 当前审阅范围，并把外部跳转定向到唯一 Review 标签。
import { create } from 'zustand';
import { useDockTabs } from '../../dockTabs.js';

export type ReviewSource =
  | { readonly kind: 'latest' }
  | { readonly kind: 'session' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'staged' }
  | { readonly kind: 'unstaged' }
  | { readonly kind: 'branch'; readonly branch: string }
  | { readonly kind: 'commit'; readonly sha: string; readonly subject: string };

interface ReviewNavigationState {
  readonly sourceBySession: Readonly<Record<string, ReviewSource>>;
  setSource(sessionId: string, source: ReviewSource): void;
}

export const useReviewNavigation = create<ReviewNavigationState>((set) => ({
  sourceBySession: {},
  setSource(sessionId, source) {
    set((state) => ({ sourceBySession: { ...state.sourceBySession, [sessionId]: source } }));
  },
}));

export function openReview(sessionId: string, source: ReviewSource): void {
  useReviewNavigation.getState().setSource(sessionId, source);
  useDockTabs.getState().openTab(sessionId, { id: 'review', kind: 'review' });
}
