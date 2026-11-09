// The NIFTY 50 table of the JPEG export: the time of the snapshot, the time left to the close, and the day's move
// and range. Times are IST.

import { roundTo } from './columns.js';
import { expiryOrder } from './positions.js';

const IST_OFFSET_MS = 330 * 60_000;
const CLOSE_SECONDS = (15 * 60 + 40) * 60; // 3:40 PM
const NONE = '—';

const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});
const clockWithSeconds = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});
const pointsFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const points = (value) => pointsFormat.format(roundTo(value, 2));
const signed = (value) => `${roundTo(value, 2) > 0 ? '+' : ''}${points(value)}`;

/** "1 hr 15 min" to 3:40 PM IST, or "Market closed" after it and at weekends. */
function timeLeft(now) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  const seconds = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  if (day === 0 || day === 6 || seconds > CLOSE_SECONDS) return 'Market closed';
  const minutes = Math.floor((CLOSE_SECONDS - seconds) / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} hr ${minutes % 60} min` : `${minutes} min`;
}

/** "25,901.10 at 10:42 AM", without the time when it isn't known. */
function madeAt(value, at) {
  if (value === null || value === undefined) return NONE;
  return at ? `${points(value)} at ${clock.format(new Date(at))}` : points(value);
}

/** Of the `legs` of one expiry, the one of `type` (CE / PE) whose strike is nearest the LTP, either side. */
function nearestLeg(legs, type, ltp) {
  return legs
    .filter((leg) => leg.type === type)
    .reduce((best, leg) => (!best || Math.abs(leg.strike - ltp) < Math.abs(best.strike - ltp) ? leg : best), null);
}

/**
 * "24500 CE (+527.00) @ 45.20 LTP": the distance of the strike from the NIFTY LTP, positive out of the money
 * (a CE above the LTP, a PE below it) and negative in it, then the option's own LTP when it is known.
 */
function firstAt(leg, ltp) {
  if (!leg) return NONE;
  const distance = leg.type === 'CE' ? leg.strike - ltp : ltp - leg.strike;
  const price = leg.ltp === null || leg.ltp === undefined ? '' : ` @ ${points(leg.ltp)} LTP`;
  return `${leg.strike} ${leg.type} (${signed(distance)})${price}`;
}

/**
 * [label, value] rows for a `daily` update from the server (null while there is none) at `now`.
 * The move is against the previous day's close. `sold` are the SELL positions, [{ expiry ('27OCT2026'), strike,
 * type, ltp }], for the first CE / PE: the sold strike nearest the LTP, in the nearest expiry that has one sold.
 */
export function niftyRows(daily, { sold = [], now = new Date() } = {}) {
  const ltp = daily?.ltp ?? null;
  const expiry = sold.map((leg) => leg.expiry).sort((a, b) => expiryOrder(a) - expiryOrder(b))[0];
  const legs = ltp === null ? [] : sold.filter((leg) => leg.expiry === expiry);
  const prevClose = daily?.prevDay?.close ?? null;
  const today = daily?.today ?? null;
  let niftyAt = NONE;
  if (ltp !== null) {
    niftyAt = prevClose
      ? `${points(ltp)}  ${signed(ltp - prevClose)}  (${signed(((ltp - prevClose) / prevClose) * 100)}%)`
      : points(ltp);
  }
  return [
    ['Current Time', clockWithSeconds.format(now)],
    ['Time Left To Market Closing', timeLeft(now)],
    ['Nifty At', niftyAt],
    ['Nifty Made High At', madeAt(today?.high, today?.highAt)],
    ['Nifty Made Low At', madeAt(today?.low, today?.lowAt)],
    ['Nifty Total Range Today', today ? points(today.high - today.low) : NONE],
    ['First CE At', firstAt(nearestLeg(legs, 'CE', ltp), ltp)],
    ['First PE At', firstAt(nearestLeg(legs, 'PE', ltp), ltp)],
  ];
}
