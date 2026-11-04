import crypto from 'node:crypto';

// Upstox market data, the app's main source (Angel One is the fallback): the V3 market-data WebSocket and daily
// candles. Read-only, with the token in UPSTOX_ACCESS_TOKEN (a daily access token or the 1-year Analytics Token).
// Feed frames are protobuf (MarketDataFeedV3.proto in upstox-python-sdk); the few fields used are decoded here.
// Option instrument keys are "NSE_FO|<NSE token>", the same token Angel One uses.

const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const API_ROOT = 'https://api.upstox.com';
export const NIFTY_INDEX_KEY = 'NSE_INDEX|Nifty 50';
const TIMEOUT_MS = 15_000;
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

export class UpstoxError extends Error {}

function accessToken() {
  return (process.env.UPSTOX_ACCESS_TOKEN ?? '').trim().replace(/^Bearer\s+/i, '');
}

export function upstoxConfigured() {
  return Boolean(accessToken());
}

// ---------------------------------------------------------------- protobuf

/** A protobuf message as Map<field number, values>; nested messages and strings stay as bytes. */
function readMessage(bytes) {
  const fields = new Map();
  let pos = 0;
  const varint = () => {
    // Arithmetic, not bit operations, so timestamps past 2^31 stay exact
    let value = 0;
    let scale = 1;
    let byte;
    do {
      byte = bytes[pos++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  };
  while (pos < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    let value;
    switch (key % 8) {
      case 0:
        value = varint();
        break;
      case 1: // every 64-bit field read here is a double
        value = new DataView(bytes.buffer, bytes.byteOffset + pos, 8).getFloat64(0, true);
        pos += 8;
        break;
      case 2: {
        const length = varint();
        value = bytes.subarray(pos, pos + length);
        pos += length;
        break;
      }
      case 5:
        pos += 4;
        continue;
      default:
        throw new UpstoxError(`Unexpected protobuf wire type ${key % 8}.`);
    }
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return fields;
}

const first = (fields, number) => fields?.get(number)?.[0];
const nested = (fields, number) => (first(fields, number) ? readMessage(first(fields, number)) : null);
const text = (bytes) => (bytes ? new TextDecoder().decode(bytes) : '');

/** LTPC: ltp = 1, ltt = 2 (ms), cp = 4 (previous close). Proto3 leaves out zeros. */
function readLtpc(ltpc) {
  return ltpc && { ltp: first(ltpc, 1) ?? 0, time: first(ltpc, 2) ?? 0, close: first(ltpc, 4) ?? 0 };
}

/** OptionGreeks (delta = 1) and the IV that goes with them. */
function addGreeks(tick, greeks, iv) {
  if (!greeks) return;
  tick.delta = first(greeks, 1) ?? 0;
  // The feed gives IV as a fraction; the app shows percent, as Angel One does
  if (iv > 0) tick.iv = iv < 5 ? iv * 100 : iv;
}

/**
 * The ticks in one feed frame: [{ key, ltp, time, close }] plus open / high / low (the "1d" candle of a full
 * feed) and delta / iv (option_greeks mode, or full mode for an option).
 */
export function decodeFeed(buffer) {
  const ticks = [];
  // FeedResponse: feeds = 2, a map<string, Feed>
  for (const entry of readMessage(new Uint8Array(buffer)).get(2) ?? []) {
    const pair = readMessage(entry);
    const key = text(first(pair, 1));
    const feed = nested(pair, 2); // Feed: ltpc = 1, fullFeed = 2, firstLevelWithGreeks = 3
    if (!feed) continue;
    let tick = null;
    const full = nested(feed, 2); // FullFeed: marketFF = 1, indexFF = 2
    const withGreeks = nested(feed, 3); // FirstLevelWithGreeks: ltpc = 1, optionGreeks = 3, iv = 6
    if (full) {
      const index = nested(full, 2); // IndexFullFeed: ltpc = 1, marketOHLC = 2
      const market = nested(full, 1); // MarketFullFeed: ltpc = 1, optionGreeks = 3, marketOHLC = 4, iv = 8
      const body = index ?? market;
      tick = readLtpc(nested(body, 1));
      // MarketOHLC: ohlc = 1; OHLC: interval = 1, open = 2, high = 3, low = 4
      const day = (nested(body, index ? 2 : 4)?.get(1) ?? []).map(readMessage).find((ohlc) => text(first(ohlc, 1)) === '1d');
      if (tick && day) Object.assign(tick, { open: first(day, 2) ?? 0, high: first(day, 3) ?? 0, low: first(day, 4) ?? 0 });
      if (tick && market) addGreeks(tick, nested(market, 3), first(market, 8));
    } else if (withGreeks) {
      tick = readLtpc(nested(withGreeks, 1));
      if (tick) addGreeks(tick, nested(withGreeks, 3), first(withGreeks, 6));
    } else {
      tick = readLtpc(nested(feed, 1));
    }
    if (tick) ticks.push({ key, ...tick });
  }
  return ticks;
}

// --------------------------------------------------------------- WebSocket

const watchers = new Map(); // name → { mode, keys: Set<string>, onTick }
const statusListeners = new Set();
let socket = null;
let connecting = false;
let subscribed = new Map(); // instrument key → mode subscribed on `socket`
// idle | connecting | live | error; `refused` when the connection was refused (not dropped), usually the token
let status = { state: 'idle', message: '', refused: false };
let retryTimer = null;
let backoff = 0;

function setStatus(state, message = '', refused = false) {
  if (status.state === state && status.message === message && status.refused === refused) return;
  status = { state, message, refused };
  for (const listener of statusListeners) listener(status);
}

export function upstoxFeedStatus() {
  return status;
}

/** Calls `listener(status)` on every change; returns a function that stops it. */
export function onUpstoxFeedStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** instrument key → mode some watcher wants (Upstox has one mode per key). */
function wanted() {
  const keys = new Map();
  for (const { mode, keys: watched } of watchers.values()) for (const key of watched) keys.set(key, mode);
  return keys;
}

// Upstox only accepts requests as binary frames
function request(method, data) {
  socket.send(new TextEncoder().encode(JSON.stringify({ guid: crypto.randomUUID(), method, data })));
}

function sync() {
  const keys = wanted();
  if (!keys.size) {
    disconnect();
    setStatus('idle');
    return;
  }
  if (!socket) {
    if (!connecting && !retryTimer) connect();
    return;
  }
  if (socket.readyState !== WebSocket.OPEN) return; // onopen syncs
  const removed = [...subscribed.keys()].filter((key) => !keys.has(key));
  if (removed.length) request('unsub', { instrumentKeys: removed });
  const byMode = new Map();
  for (const [key, mode] of keys) {
    if (subscribed.get(key) === mode) continue;
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(key);
  }
  for (const [mode, instrumentKeys] of byMode) request('sub', { mode, instrumentKeys });
  subscribed = keys;
}

function disconnect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket) {
    const old = socket;
    socket = null;
    old.onclose = null;
    old.onmessage = null;
    try {
      old.close();
    } catch {
      // Already closed
    }
  }
  subscribed = new Map();
}

function retry(message, refused) {
  disconnect();
  if (!wanted().size) return;
  backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : FIRST_BACKOFF_MS);
  // The timer goes first: status listeners may sync the watchers, which must not connect again meanwhile
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, backoff);
  setStatus('error', `${message} Reconnecting in ${Math.round(backoff / 1000)}s.`, refused);
}

/**
 * The one-time feed URL Upstox hands out for the token. The feed URL itself answers with a redirect there,
 * which a WebSocket handshake can't follow.
 */
async function authorizedFeedUrl() {
  let response;
  try {
    response = await fetch(AUTHORIZE_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UpstoxError('Cannot reach Upstox.');
  }
  const body = await response.json().catch(() => null);
  const url = body?.data?.authorized_redirect_uri ?? body?.data?.authorizedRedirectUri;
  if (response.ok && url) return url;
  const message = body?.errors?.[0]?.message || `Upstox returned HTTP ${response.status}.`;
  const err = new UpstoxError(response.status === 401 || response.status === 403 ? `Upstox refused the token (${message}).` : message);
  err.refused = response.status === 401 || response.status === 403;
  throw err;
}

async function connect() {
  if (socket || connecting) return;
  if (!upstoxConfigured()) {
    setStatus('error', 'Set UPSTOX_ACCESS_TOKEN in .env to use Upstox.', true);
    return;
  }
  connecting = true;
  setStatus('connecting');
  let url;
  try {
    url = await authorizedFeedUrl();
  } catch (err) {
    connecting = false;
    retry(err.message, Boolean(err.refused));
    return;
  }
  connecting = false;
  if (!wanted().size || socket) return;

  let opened = false;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  subscribed = new Map();
  ws.onopen = () => {
    opened = true;
    backoff = 0;
    setStatus('live');
    sync();
  };
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') return;
    let ticks;
    try {
      ticks = decodeFeed(event.data);
    } catch (err) {
      console.error(`Upstox feed: ${err.message}`);
      return;
    }
    for (const tick of ticks) {
      for (const watcher of watchers.values()) if (watcher.keys.has(tick.key)) watcher.onTick(tick);
    }
  };
  ws.onerror = () => {}; // onclose follows
  ws.onclose = () => {
    if (socket === ws) retry(opened ? 'The Upstox feed disconnected.' : 'Cannot connect to the Upstox feed.', !opened);
  };
}

/**
 * Starts, changes or (with `spec` null or no keys) stops the ticks for `name`.
 * spec: { mode: 'ltpc' | 'full' | 'option_greeks', keys: string[], onTick(tick) }
 */
export function upstoxWatch(name, spec) {
  if (spec?.keys.length) watchers.set(name, { ...spec, keys: new Set(spec.keys) });
  else watchers.delete(name);
  sync();
}

// ------------------------------------------------------------------ candles

/** Daily candles of an instrument from `from` to `to` ("2026-10-30"), oldest first: [{ date, open, high, low, close }]. */
export async function upstoxDailyCandles(instrumentKey, from, to) {
  if (!upstoxConfigured()) throw new UpstoxError('Set UPSTOX_ACCESS_TOKEN in .env to use Upstox.');
  let response;
  try {
    response = await fetch(`${API_ROOT}/v3/historical-candle/${encodeURIComponent(instrumentKey)}/days/1/${to}/${from}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UpstoxError('Cannot reach Upstox.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'success') {
    throw new UpstoxError(body?.errors?.[0]?.message || `Upstox returned HTTP ${response.status}.`);
  }
  // Newest first; each row is [timestamp, open, high, low, close, volume, oi], the timestamp like 2026-10-30T00:00:00+05:30
  return (body.data?.candles ?? [])
    .map(([time, open, high, low, close]) => ({ date: String(time).slice(0, 10), open, high, low, close }))
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every((value) => value > 0))
    .reverse();
}
