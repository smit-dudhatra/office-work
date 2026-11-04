import { dailyCandles, nseQuote } from './angel.js';
import { feedStatus, onSourceChange, sourceInfo, watch } from './feed.js';
import { istDate, marketOpen } from './market.js';
import { NIFTY_INDEX_KEY, upstoxConfigured, upstoxDailyCandles } from './upstox.js';

// Daily analysis of NIFTY 50 for the browser: past daily candles (loaded once a day) against today's candle,
// which moves tick by tick on the live feed. Upstox is the source, Angel One the fallback for both. Upstox sends
// a snapshot of today's candle when it subscribes, so the last session shows when the market is closed; on Angel
// one REST quote does that. Server-sent events: `status` and `daily`.

const NIFTY_TOKEN = '99926000'; // NIFTY 50 index on NSE (Angel One)
const ANGEL_CHUNK_DAYS = 1990; // an Angel daily-candle request covers at most 2000 days
const UPSTOX_CHUNK_DAYS = 3600; // an Upstox one covers at most ten years
const HISTORY_YEARS = 32; // for the all-time high
const CANDLE_GAP_MS = 400; // candle requests: three a second
const RETRY_MS = 30_000;
const PUSH_MS = 250; // at most four updates a second
const STATUS_CHECK_MS = 30_000; // notices the market opening or closing
const HEARTBEAT_MS = 15_000;
export const EMA_PERIODS = [5, 21, 252];

const clients = new Set(); // { res }
let status = { state: 'connecting', message: '' };
let problem = null; // { state, message } when the candles or the first quote couldn't be loaded
let history = null; // { candles, loadedOn }
let today = null; // { date, time, ltp, open, high, low }
let latest = null; // last `daily` payload
let starting = null;
let retryTimer = null;
let pushTimer = null;
let statusTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Monday of the week of a "2026-10-30" date. */
function weekStart(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** EMA of `closes` (oldest first, seeded with the average of the first `period`) carried on to `ltp`. */
function liveEma(closes, period, ltp) {
  if (closes.length < period) return null;
  const alpha = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, close) => sum + close, 0) / period;
  for (const close of closes.slice(period)) ema += alpha * (close - ema);
  return ema + alpha * (ltp - ema);
}

/**
 * The levels the daily table compares the LTP with. `candles` are past daily candles, oldest first (any for
 * today's date are ignored); `now` is today's candle so far, { date, ltp, open, high, low }.
 */
export function analyseDaily(candles, now) {
  const past = candles.filter((candle) => candle.date < now.date);
  const prevDay = past.at(-1) ?? null;

  const thisWeek = weekStart(now.date);
  const earlier = past.filter((candle) => weekStart(candle.date) < thisWeek);
  const lastWeek = earlier.length ? weekStart(earlier.at(-1).date) : null;
  const week = earlier.filter((candle) => weekStart(candle.date) === lastWeek);

  const green = past.findLast((candle) => candle.close > candle.open);
  const red = past.findLast((candle) => candle.close < candle.open);
  const athBefore = past.reduce((top, candle) => (!top || candle.high > top.high ? candle : top), null);
  // Before the open, Angel can report zeros for the day's open / high / low
  const candle = now.open > 0 && now.high > 0 && now.low > 0 ? { open: now.open, high: now.high, low: now.low } : null;
  const newHigh = candle && (!athBefore || candle.high > athBefore.high);
  // After the same date a year back; as on NSE, today's low counts towards the 52-week low
  const yearAgo = `${Number(now.date.slice(0, 4)) - 1}${now.date.slice(4)}`;
  const yearLow = past
    .filter((c) => c.date > yearAgo)
    .reduce((bottom, c) => (!bottom || c.low < bottom.low ? c : bottom), null);
  const newLow = candle && (!yearLow || candle.low < yearLow.low);
  const closes = past.map((c) => c.close);

  return {
    date: now.date,
    ltp: now.ltp,
    today: candle,
    prevDay: prevDay && { date: prevDay.date, open: prevDay.open, high: prevDay.high, low: prevDay.low, close: prevDay.close },
    prevWeek: week.length
      ? {
          from: week[0].date,
          to: week.at(-1).date,
          high: Math.max(...week.map((c) => c.high)),
          low: Math.min(...week.map((c) => c.low)),
          close: week.at(-1).close,
        }
      : null,
    prevGreen: green ? { date: green.date, low: green.low } : null,
    prevRed: red ? { date: red.date, high: red.high } : null,
    allTimeHigh: athBefore || candle
      ? {
          value: newHigh ? candle.high : athBefore.high,
          date: newHigh ? now.date : athBefore.date,
          before: athBefore?.high ?? null, // the highest high before today
          since: past[0]?.date ?? null, // first candle Angel returned
        }
      : null,
    low52Week: yearLow || candle
      ? { value: newLow ? candle.low : yearLow.low, date: newLow ? now.date : yearLow.date }
      : null,
    ema: Object.fromEntries(EMA_PERIODS.map((period) => [period, liveEma(closes, period, now.ltp)])),
  };
}

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function updateStatus() {
  const feed = feedStatus();
  let next;
  if (problem) next = problem;
  else if (feed.state === 'needs-login' || feed.state === 'error') next = { state: feed.state, message: feed.message };
  else if (!latest || feed.state === 'connecting') next = { state: 'connecting', message: '' };
  else next = { state: marketOpen() ? 'live' : 'closed', message: '' }; // live, or idle between watchers
  next = { ...next, ...sourceInfo() };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const client of clients) send(client, 'status', status);
}

onSourceChange(() => {
  if (clients.size) updateStatus();
});

function push() {
  pushTimer = null;
  if (!history || !today) return;
  latest = { symbol: 'NIFTY 50', updatedAt: new Date(today.time).toISOString(), ...analyseDaily(history.candles, today) };
  for (const client of clients) send(client, 'daily', latest);
  updateStatus();
  // A new day: yesterday's candle is now history
  if (history.loadedOn !== istDate() && !starting && !retryTimer) start();
}

function setToday(next) {
  // A REST quote can be older than a tick that arrived while it was on its way
  if (today && next.time < today.time) return;
  today = next;
  pushTimer ??= setTimeout(push, PUSH_MS);
}

function onTick(tick) {
  if (tick.kind !== 'index' || !(tick.ltp > 0)) return;
  const time = tick.time > 0 ? tick.time : Date.now();
  setToday({ date: istDate(time), time, ltp: tick.ltp, open: tick.open, high: tick.high, low: tick.low });
}

/** Daily candles, oldest first, going back `chunkDays` per request until the source has no more. */
async function loadCandles(fetchRange, chunkDays) {
  const candles = [];
  let to = Date.now();
  const oldest = to - HISTORY_YEARS * 365 * 86_400_000;
  for (let chunk = 0; to > oldest; chunk += 1) {
    const from = to - chunkDays * 86_400_000;
    if (chunk) await sleep(CANDLE_GAP_MS);
    let rows;
    try {
      rows = await fetchRange(istDate(from), istDate(to));
    } catch (err) {
      if (!chunk) throw err;
      break; // the older years only matter for the all-time high
    }
    if (!rows.length) break;
    candles.unshift(...rows);
    to = from - 86_400_000;
  }
  const byDate = new Map(candles.map((candle) => [candle.date, candle]));
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** NIFTY 50 daily candles from Upstox, or from Angel One when Upstox can't give them. */
async function loadHistory() {
  let upstoxError = null;
  if (upstoxConfigured()) {
    try {
      return await loadCandles((from, to) => upstoxDailyCandles(NIFTY_INDEX_KEY, from, to), UPSTOX_CHUNK_DAYS);
    } catch (err) {
      upstoxError = err;
    }
  }
  try {
    return await loadCandles((from, to) => dailyCandles('NSE', NIFTY_TOKEN, from, to), ANGEL_CHUNK_DAYS);
  } catch (err) {
    // Keep Angel's error code, so a needed login still shows the login form
    if (upstoxError) err.message = `Upstox: ${upstoxError.message} ${err.message}`;
    throw err;
  }
}

async function startNow() {
  clearTimeout(retryTimer);
  retryTimer = null;
  try {
    if (history?.loadedOn !== istDate()) history = { candles: await loadHistory(), loadedOn: istDate() };
    if (!clients.size) return;
    problem = null;
    watch('daily', { index: true, onTick });
    if (sourceInfo().source === 'angel') {
      try {
        const quote = await nseQuote(NIFTY_TOKEN);
        if (quote) setToday(quote);
      } catch (err) {
        // Ticks fill in today's candle; the fallback's snapshot does when Angel can't
        console.error(`NIFTY 50 quote: ${err.message}`);
      }
    }
  } catch (err) {
    problem = {
      state: err.code === 'NEEDS_LOGIN' ? 'needs-login' : 'error',
      message: err.message || 'Could not load the NIFTY 50 candles.',
    };
    // After a login, refreshDaily() starts again
    if (err.code !== 'NEEDS_LOGIN' && clients.size) {
      problem.message += ` Retrying in ${RETRY_MS / 1000}s.`;
      retryTimer = setTimeout(start, RETRY_MS);
    }
  }
  updateStatus();
}

function start() {
  starting ??= startNow().finally(() => {
    starting = null;
  });
  return starting;
}

/** Start again now, e.g. after a login. */
export function refreshDaily() {
  problem = null;
  if (clients.size) start();
}

/** GET /api/daily/stream */
export function streamDaily(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { res };
  clients.add(client);
  send(client, 'status', status);
  if (latest) send(client, 'daily', latest);
  // Comments keep idle connections (and the dev proxy) open
  const heartbeat = setInterval(() => res.write(':\n\n'), HEARTBEAT_MS);
  statusTimer ??= setInterval(updateStatus, STATUS_CHECK_MS);
  if (clients.size === 1) start();

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    if (clients.size) return;
    watch('daily', null);
    clearInterval(statusTimer);
    clearTimeout(retryTimer);
    statusTimer = null;
    retryTimer = null;
  });
}
