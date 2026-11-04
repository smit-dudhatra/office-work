import { useEffect, useSyncExternalStore } from 'react';

// Which parts of the page wait for an Angel One login, so the page shows one login form for all of them.
// A part either has no live data without it (Upstox is down too), or has Upstox data and only wants the
// fallback ready; the banner is slim then.

const DEFAULT_MESSAGE = 'Log in to Angel One with your TOTP to get live data.';
const waiting = new Map(); // source → { message, slim }
const listeners = new Set();
let snapshot = null; // { message, slim } or null

function report(source, entry) {
  if (entry) waiting.set(source, entry);
  else waiting.delete(source);
  const entries = [...waiting.values()];
  // Slim only when every waiting part has data anyway
  const next = entries.length
    ? { message: (entries.find((e) => !e.slim) ?? entries[0]).message, slim: entries.every((e) => e.slim) }
    : null;
  if (next?.message === snapshot?.message && next?.slim === snapshot?.slim) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tells the page whether the live data of `source` waits for an Angel One login. */
export function useLoginReport(source, { status, message, angelLogin, upstoxProblem }) {
  useEffect(() => {
    let entry = null;
    if (status === 'needs-login') {
      const why = upstoxProblem ? `Upstox is unavailable (${upstoxProblem}). ` : '';
      entry = { message: `${why}${message || DEFAULT_MESSAGE}`, slim: false };
    } else if (angelLogin) {
      entry = { message: angelLogin, slim: true };
    }
    report(source, entry);
  }, [source, status, message, angelLogin, upstoxProblem]);
  useEffect(() => () => report(source, null), [source]);
}

/** Why a login is needed and whether live data flows meanwhile ({ message, slim }), or null. */
export function useLoginNeeded() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
