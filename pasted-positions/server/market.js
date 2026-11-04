// NSE trading hours and dates in IST (holidays aren't known here).

const IST_OFFSET_MS = 330 * 60_000;

/** Weekdays 09:15–15:40 IST. */
export function marketOpen(now = Date.now()) {
  const ist = new Date(Number(now) + IST_OFFSET_MS);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const day = ist.getUTCDay();
  return day >= 1 && day <= 5 && minutes >= 555 && minutes <= 940;
}

/** "2026-10-30", the IST date of a time in milliseconds. */
export function istDate(time = Date.now()) {
  return new Date(Number(time) + IST_OFFSET_MS).toISOString().slice(0, 10);
}
