/**
 * Minimal session-state bridge: the token lives in localStorage (api.ts owns
 * storage); this module just makes "is someone signed in?" observable so the
 * shell re-renders on login/logout/401 without a state library.
 */
import { clearTokens, getAccessToken } from "./api.js";

type Listener = () => void;

const listeners = new Set<Listener>();

export function isAuthenticated(): boolean {
  return getAccessToken() !== null;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAuthChanged(): void {
  for (const listener of listeners) listener();
}

export function signOut(): void {
  clearTokens();
  notifyAuthChanged();
}
