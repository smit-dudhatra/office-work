import { useEffect, useState } from 'react';

/**
 * Live option greeks from the server for the given expiries ("27OCT2026").
 * Returns { status, message, greeks: { [expiry]: { fetchedAt, strikes: { '22050PE': { delta, iv } } } } }.
 * status: connecting | live | closed | needs-login | error | offline
 */
export function useLiveGreeks(expiries) {
  const key = expiries.join(',');
  const [state, setState] = useState({ status: 'connecting', message: '', greeks: {} });

  useEffect(() => {
    if (!key) return undefined;
    setState({ status: 'connecting', message: '', greeks: {} });
    // EventSource reconnects by itself after a dropped connection
    const source = new EventSource(`/api/greeks/stream?expiries=${encodeURIComponent(key)}`);
    source.addEventListener('status', (event) => {
      const { state: status, message } = JSON.parse(event.data);
      setState((prev) => ({ ...prev, status, message }));
    });
    source.addEventListener('greeks', (event) => {
      const update = JSON.parse(event.data);
      setState((prev) => ({ ...prev, greeks: { ...prev.greeks, [update.expiry]: update } }));
    });
    source.onerror = () => {
      setState((prev) => ({ ...prev, status: 'offline', message: 'Lost the connection to the server. Retrying…' }));
    };
    return () => source.close();
  }, [key]);

  return state;
}
