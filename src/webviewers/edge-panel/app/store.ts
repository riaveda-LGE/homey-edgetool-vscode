import type { AppState } from '../types/model.js';
import type { Action } from './actions.js';

export type Listener = (s: AppState, a: Action) => void;

export function createStore(initial: AppState, reduce: (s: AppState, a: Action) => AppState) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    dispatch: (a: Action) => {
      state = reduce(state, a);
      listeners.forEach((l) => l(state, a));
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
