import { create } from "zustand";

/** UI state of an in-flight link completion (shown on the sign-in screen). */
export interface LinkState {
  /** A link arrived but we have no stored email: ask the user for it. */
  pendingUrl: string | null;
  completing: boolean;
  error: string | null;
  setPending(url: string | null): void;
  setCompleting(v: boolean): void;
  setError(message: string | null): void;
}

export const useLinkStore = create<LinkState>((set) => ({
  pendingUrl: null,
  completing: false,
  error: null,
  setPending: (pendingUrl) => set({ pendingUrl }),
  setCompleting: (completing) => set({ completing }),
  setError: (error) => set({ error }),
}));
