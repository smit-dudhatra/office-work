import { useEffect, useState } from 'react';

const INITIAL = {
  status: 'connecting',
  message: '',
  source: 'upstox',
  angelLogin: '',
  upstoxProblem: '',
  feed: { state: 'connecting', message: '' },
  greeks: {},
  ltps: {},
};

/**
 * Live option greeks and prices from the server for the given expiries ("27OCT2026") and the strikes
 * ("27OCT2026:22050PE") whose price is wanted.
 * Returns { status, message, source, angelLogin, upstoxProblem, feed, greeks, ltps }:
 * - greeks: { [expiry]: { fetchedAt, strikes: { '22050PE': { delta, iv } } } }, from the greeks poll
 * - ltps: { [expiry]: { '22050PE': price | null } }, tick by tick; null when Angel has no price for it
 * - status (the greeks poll): connecting | live | closed | needs-login | error | offline
 * - feed (the live price feed): { state: idle | connecting | live | error | needs-login, message }
 * - source: upstox | angel (the fallback); angelLogin: why Angel One needs a login, while it does;
 *   upstoxProblem: why Upstox isn't in use, while it isn't
 */
export function useLiveGreeks(expiries, quotes = []) {
  const key = expiries.join(',');
  const quoteKey = quotes.join(',');
  const [state, setState] = useState(INITIAL);

  useEffect(() => {
    if (!key) return undefined;
    setState(INITIAL);
    // EventSource reconnects by itself after a dropped connection
    const source = new EventSource(
      `/api/greeks/stream?expiries=${encodeURIComponent(key)}&quotes=${encodeURIComponent(quoteKey)}`,
    );
    source.addEventListener('status', (event) => {
      const { state: status, message, source: from = 'upstox', angelLogin = '', upstoxProblem = '' } = JSON.parse(event.data);
      setState((prev) => ({ ...prev, status, message, source: from, angelLogin, upstoxProblem }));
    });
    source.addEventListener('feed', (event) => {
      const feed = JSON.parse(event.data);
      setState((prev) => ({ ...prev, feed }));
    });
    source.addEventListener('greeks', (event) => {
      const update = JSON.parse(event.data);
      setState((prev) => ({ ...prev, greeks: { ...prev.greeks, [update.expiry]: update } }));
    });
    // Only the strikes whose price changed
    source.addEventListener('ltps', (event) => {
      const { expiry, ltps } = JSON.parse(event.data);
      setState((prev) => ({ ...prev, ltps: { ...prev.ltps, [expiry]: { ...prev.ltps[expiry], ...ltps } } }));
    });
    source.onerror = () => {
      setState((prev) => ({ ...prev, status: 'offline', message: 'Lost the connection to the server. Retrying…' }));
    };
    return () => source.close();
  }, [key, quoteKey]);

  return state;
}
