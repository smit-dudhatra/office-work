import { useCallback, useEffect, useState } from 'react';
import { RETRY_MS, fetchMargin } from './api.js';

// Quick flips of several rows send one request
const DEBOUNCE_MS = 400;
const IDLE = { status: 'idle', margin: null, error: '' };

/**
 * Margin (NRML) of the positions, from the server: Upstox, or Angel One as the fallback. Worked out again when a
 * position or its side changes, and on refresh(). positions: [{ expiry, strike, type, quantity, buy }].
 * Returns { status: idle | loading | waiting | ok | error, margin, error, refresh }. `waiting`: the server can't be
 * reached (e.g. while `npm run dev` restarts it), so it is asked again every few seconds. `margin` is the server's reply
 * ({ source, approximate, requests, final, required, benefit, span, exposure, premium, legs, missing, skipped, at };
 * `final` is an upper bound when `approximate`). While a new one loads, `margin` is the last one; after an error it
 * is null.
 */
export function useMargin(positions) {
  const key = JSON.stringify(positions);
  const [run, setRun] = useState(0);
  const [state, setState] = useState(IDLE);

  useEffect(() => {
    const body = JSON.parse(key);
    if (!body.length) {
      setState(IDLE);
      return undefined;
    }
    const controller = new AbortController();
    let retry = null;
    setState((prev) => ({ ...prev, status: 'loading', error: '' }));
    const timer = setTimeout(() => {
      fetchMargin(body, controller.signal).then(
        (margin) => {
          if (!controller.signal.aborted) setState({ status: 'ok', margin, error: '' });
        },
        (err) => {
          if (controller.signal.aborted) return;
          if (err.unreachable) {
            // Keep the last figure (dimmed) and ask again once the server is back
            setState((prev) => ({ ...prev, status: 'waiting', error: err.message }));
            retry = setTimeout(() => setRun((n) => n + 1), RETRY_MS);
          } else {
            setState({ status: 'error', margin: null, error: err.message });
          }
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(retry);
      controller.abort();
    };
  }, [key, run]);

  const refresh = useCallback(() => setRun((n) => n + 1), []);
  return { ...state, refresh };
}
