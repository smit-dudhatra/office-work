import { useEffect, useState } from 'react';
import { RETRY_MS, fetchLotSizes } from './api.js';

/**
 * Lot sizes of NIFTY options by expiry ("27OCT2026"), from Angel One's instrument list, for sheets without a
 * Lot Size column: { '27OCT2026': 65 }, or null while they load. While the server can't be reached they stay null
 * and are asked for again every few seconds; after any other failure they are {} (no lot sizes known).
 */
export function useLotSizes(expiries) {
  const key = expiries.join(',');
  const [lotSizes, setLotSizes] = useState(null);

  useEffect(() => {
    if (!key) {
      setLotSizes({});
      return undefined;
    }
    let current = true;
    let retry = null;
    setLotSizes(null);
    const load = () =>
      fetchLotSizes(key.split(',')).then(
        (sizes) => current && setLotSizes(sizes),
        (err) => {
          if (!current) return;
          if (err.unreachable) retry = setTimeout(load, RETRY_MS);
          else setLotSizes({});
        },
      );
    load();
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [key]);

  return lotSizes;
}
