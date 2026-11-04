import { streamCredentials } from './angel.js';

// Angel One SmartStream (WebSocket V2): live ticks for whatever parts of the app watch. One connection serves
// every watcher; it opens while something is watched, reconnects with backoff, and closes when nothing is.
// Ticks are binary, little-endian, with prices in paise (layout as in high-low-break-alert.py).

const URL = 'wss://smartapisocket.angelone.in/smart-stream';
export const NSE_CM = 1;
export const NSE_FO = 2;
export const LTP_MODE = 1; // LTP only
export const QUOTE_MODE = 2; // LTP plus the day's open, high, low and the previous close
const PING_MS = 10_000; // SmartStream expects a text "ping" and answers "pong"
const SILENCE_MS = 35_000; // nothing received for this long: the connection is dead
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

const watchers = new Map(); // name → { mode, exchangeType, tokens: Set<string>, onTick }
const statusListeners = new Set();
let socket = null;
let subscribed = new Map(); // "mode|exchangeType" → tokens subscribed on `socket`
let connecting = false;
let status = { state: 'idle', message: '' }; // idle | connecting | live | error | needs-login
let retryTimer = null;
let pingTimer = null;
let backoff = 0;
let lastMessage = 0;

/** One tick from a binary frame: { mode, exchangeType, token, time, ltp } plus open / high / low / close in Quote mode. */
export function parseTick(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 51) return null;
  const int64 = (offset) => Number(view.getBigInt64(offset, true));
  const tokenBytes = new Uint8Array(buffer, 2, 25);
  const end = tokenBytes.indexOf(0);
  const tick = {
    mode: view.getUint8(0),
    exchangeType: view.getUint8(1),
    token: new TextDecoder().decode(tokenBytes.subarray(0, end < 0 ? 25 : end)),
    time: int64(35),
    ltp: int64(43) / 100,
  };
  if (tick.mode >= QUOTE_MODE && view.byteLength >= 123) {
    Object.assign(tick, { open: int64(91) / 100, high: int64(99) / 100, low: int64(107) / 100, close: int64(115) / 100 });
  }
  return tick;
}

function setStatus(state, message = '') {
  if (status.state === state && status.message === message) return;
  status = { state, message };
  for (const listener of statusListeners) listener(status);
}

export function feedStatus() {
  return status;
}

/** Calls `listener(status)` on every change; returns a function that stops it. */
export function onFeedStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** "mode|exchangeType" → every token some watcher wants. */
function wanted() {
  const groups = new Map();
  for (const { mode, exchangeType, tokens } of watchers.values()) {
    const key = `${mode}|${exchangeType}`;
    if (!groups.has(key)) groups.set(key, new Set());
    for (const token of tokens) groups.get(key).add(token);
  }
  for (const [key, tokens] of groups) if (!tokens.size) groups.delete(key);
  return groups;
}

function request(action, key, tokens) {
  const [mode, exchangeType] = key.split('|').map(Number);
  socket.send(
    JSON.stringify({
      correlationID: 'pastedpos',
      action, // 1 subscribe, 0 unsubscribe
      params: { mode, tokenList: [{ exchangeType, tokens: [...tokens] }] },
    }),
  );
}

/** Brings the connection and its subscriptions in line with the watchers. */
function sync() {
  const groups = wanted();
  if (!groups.size) {
    disconnect();
    setStatus('idle');
    return;
  }
  if (!socket) {
    if (!connecting && !retryTimer) connect();
    return;
  }
  if (socket.readyState !== WebSocket.OPEN) return; // onopen syncs
  for (const [key, tokens] of groups) {
    const have = subscribed.get(key) ?? new Set();
    const added = [...tokens].filter((token) => !have.has(token));
    if (added.length) request(1, key, added);
  }
  for (const [key, have] of subscribed) {
    const removed = [...have].filter((token) => !groups.get(key)?.has(token));
    if (removed.length) request(0, key, removed);
  }
  subscribed = groups;
}

function disconnect() {
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  retryTimer = null;
  pingTimer = null;
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

function retry(message) {
  disconnect();
  if (!wanted().size) return;
  backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : FIRST_BACKOFF_MS);
  // The timer goes first: status listeners may sync the watchers, which must not connect again meanwhile
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, backoff);
  setStatus('error', `${message} Reconnecting in ${Math.round(backoff / 1000)}s.`);
}

async function connect() {
  if (connecting || socket) return;
  connecting = true;
  setStatus('connecting');
  let auth;
  try {
    auth = await streamCredentials();
  } catch (err) {
    connecting = false;
    if (err.code === 'NEEDS_LOGIN') setStatus('needs-login', err.message); // reconnect() after a login
    else retry(err.message || 'Cannot start the live feed.');
    return;
  }
  connecting = false;
  if (!wanted().size || socket) return;

  const ws = new WebSocket(URL, {
    headers: {
      Authorization: auth.jwt,
      'x-api-key': auth.apiKey,
      'x-client-code': auth.clientCode,
      'x-feed-token': auth.feedToken,
    },
  });
  ws.binaryType = 'arraybuffer';
  socket = ws;
  subscribed = new Map();
  ws.onopen = () => {
    backoff = 0;
    lastMessage = Date.now();
    setStatus('live');
    pingTimer = setInterval(() => {
      if (Date.now() - lastMessage > SILENCE_MS) retry('The live feed stopped responding.');
      else ws.send('ping');
    }, PING_MS);
    sync();
  };
  ws.onmessage = (event) => {
    lastMessage = Date.now();
    if (typeof event.data === 'string') {
      // "pong", or an error such as an invalid subscription
      if (event.data !== 'pong') {
        try {
          const { errorMessage } = JSON.parse(event.data);
          if (errorMessage) setStatus('error', `Angel One live feed: ${errorMessage}`);
        } catch {
          // Not JSON; nothing to report
        }
      }
      return;
    }
    const tick = parseTick(event.data);
    if (!tick) return;
    for (const watcher of watchers.values()) {
      if (watcher.exchangeType === tick.exchangeType && watcher.mode <= tick.mode && watcher.tokens.has(tick.token)) {
        watcher.onTick(tick);
      }
    }
  };
  ws.onerror = () => {}; // onclose follows
  ws.onclose = () => {
    if (socket === ws) retry('The live feed disconnected.');
  };
}

/**
 * Starts, changes or (with `spec` null or no tokens) stops the ticks for `name`.
 * spec: { mode, exchangeType, tokens: string[], onTick(tick) }
 */
export function watch(name, spec) {
  if (spec?.tokens.length) watchers.set(name, { ...spec, tokens: new Set(spec.tokens) });
  else watchers.delete(name);
  sync();
}

/** Connect again now, e.g. after a login. */
export function reconnect() {
  backoff = 0;
  disconnect();
  sync();
}
