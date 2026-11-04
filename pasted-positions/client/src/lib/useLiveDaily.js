import { useEffect, useState } from 'react';

/**
 * The NIFTY 50 daily analysis from the server, updated on every tick.
 * Returns { status, message, source, angelLogin, upstoxProblem, daily } where `daily` is the latest update (null
 * until the first one), `source` is upstox or angel (the fallback), `angelLogin` why Angel One needs a login (while
 * it does) and `upstoxProblem` why Upstox isn't in use (while it isn't).
 * status: connecting | live | closed | needs-login | error | offline
 */
export function useLiveDaily() {
  const [state, setState] = useState({
    status: 'connecting',
    message: '',
    source: 'upstox',
    angelLogin: '',
    upstoxProblem: '',
    daily: null,
  });

  useEffect(() => {
    // EventSource reconnects by itself after a dropped connection
    const source = new EventSource('/api/daily/stream');
    source.addEventListener('status', (event) => {
      const { state: status, message, source: from = 'upstox', angelLogin = '', upstoxProblem = '' } = JSON.parse(event.data);
      setState((prev) => ({ ...prev, status, message, source: from, angelLogin, upstoxProblem }));
    });
    source.addEventListener('daily', (event) => {
      const daily = JSON.parse(event.data);
      setState((prev) => ({ ...prev, daily }));
    });
    source.onerror = () => {
      setState((prev) => ({ ...prev, status: 'offline', message: 'Lost the connection to the server. Retrying…' }));
    };
    return () => source.close();
  }, []);

  return state;
}
