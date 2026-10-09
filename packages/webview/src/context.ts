import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ViewMsg } from './protocol';
import type { Action, State } from './state';

export interface Ctx {
  state: State;
  dispatch: (a: Action) => void;
  post: (m: ViewMsg) => void;
}

export const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext missing');
  return c;
}
