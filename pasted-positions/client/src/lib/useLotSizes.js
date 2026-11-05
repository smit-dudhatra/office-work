import { useEffect, useState } from 'react';
import { fetchLotSizes } from './api.js';

/**
 * Lot sizes of NIFTY options by expiry ("27OCT2026"), from Angel One's instrument list, for sheets without a
 * Lot Size column: { '27OCT2026': 65 }, or null while they load. After a failure it is {} (no lot sizes known).
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
    setLotSizes(null);
    fetchLotSizes(key.split(',')).then(
      (sizes) => current && setLotSizes(sizes),
      () => current && setLotSizes({}),
    );
    return () => {
      current = false;
    };
  }, [key]);

  return lotSizes;
}
