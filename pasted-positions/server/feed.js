import { angelStatus } from './angel.js';
import {
  LTP_MODE,
  NSE_CM,
  NSE_FO,
  QUOTE_MODE,
  feedStatus as angelFeedStatus,
  onFeedStatus as onAngelFeedStatus,
  reconnect as reconnectAngel,
  watch as angelWatch,
} from './smartstream.js';
import { NIFTY_INDEX_KEY, onUpstoxFeedStatus, upstoxConfigured, upstoxFeedStatus, upstoxWatch } from './upstox.js';

// Live ticks for the rest of the server, from Upstox or, while Upstox isn't available, from Angel One's
// SmartStream. Upstox isn't available when UPSTOX_ACCESS_TOKEN is missing, when it refuses the connection, or
// when its feed failed MAX_UPSTOX_FAILURES times in a row. Upstox stays watched (and keeps reconnecting) meanwhile,
// so the feed goes back to it as soon as it is up again.
//
// Ticks: { kind: 'index', time, ltp, open, high, low } for NIFTY 50, and { kind: 'option', token, time, ltp }
// for an option (its NSE token), plus delta / iv from Upstox.

const ANGEL_NIFTY_TOKEN = '99926000';
const MAX_UPSTOX_FAILURES = 3;
const ANGEL_LOGIN_MESSAGE = 'Log in to Angel One with your TOTP to get live data.';

const watchers = new Map(); // name → { index: boolean, options: string[], onTick }
const listeners = new Set();
let active = 'upstox'; // upstox | angel (the fallback)
let upstoxFailures = 0;

/**
 * Which source is in use, why Angel One needs a login (while it does, so the fallback is ready), and why
 * Upstox isn't in use (while it isn't): { source, angelLogin, upstoxProblem }.
 */
export function sourceInfo() {
  const feed = angelFeedStatus();
  const angel = angelStatus();
  let angelLogin = '';
  if (feed.state === 'needs-login') angelLogin = feed.message;
  else if (angel.configured && !angel.loggedIn && !angel.autoLogin) angelLogin = ANGEL_LOGIN_MESSAGE;
  return { source: active, angelLogin, upstoxProblem: active === 'angel' ? upstoxFeedStatus().message : '' };
}

/** The status of the source in use: { state: idle | connecting | live | error | needs-login, message }. */
export function feedStatus() {
  const { state, message } = active === 'upstox' ? upstoxFeedStatus() : angelFeedStatus();
  return { state, message };
}

/** Calls `listener()` when the source, the status of either feed, or Angel's login changes; returns a function that stops it. */
export function onSourceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function deliver(name, tick) {
  watchers.get(name)?.onTick(tick);
}

/** Upstox is always watched; Angel only while it fills in. */
function syncWatcher(name) {
  const spec = watchers.get(name);
  const fromAngel = active === 'angel';
  const index = Boolean(spec?.index);
  const options = spec?.options ?? [];

  upstoxWatch(
    `${name}:index`,
    index ? {
      mode: 'full',
      keys: [NIFTY_INDEX_KEY],
      onTick: (t) => {
        if (active === 'upstox' && t.open !== undefined) {
          deliver(name, { kind: 'index', time: t.time, ltp: t.ltp, open: t.open, high: t.high, low: t.low });
        }
      },
    } : null,
  );
  upstoxWatch(
    `${name}:options`,
    options.length ? {
      mode: 'option_greeks',
      keys: options.map((token) => `NSE_FO|${token}`),
      onTick: (t) => {
        if (active !== 'upstox') return;
        const { key, time, ltp, delta, iv } = t;
        deliver(name, { kind: 'option', token: key.slice(key.indexOf('|') + 1), time, ltp, delta, iv });
      },
    } : null,
  );
  angelWatch(
    `${name}:index`,
    fromAngel && index ? {
      mode: QUOTE_MODE,
      exchangeType: NSE_CM,
      tokens: [ANGEL_NIFTY_TOKEN],
      onTick: (t) => {
        if (active === 'angel' && t.open !== undefined) {
          deliver(name, { kind: 'index', time: t.time, ltp: t.ltp, open: t.open, high: t.high, low: t.low });
        }
      },
    } : null,
  );
  angelWatch(
    `${name}:options`,
    fromAngel && options.length ? {
      mode: LTP_MODE,
      exchangeType: NSE_FO,
      tokens: options,
      onTick: (t) => {
        if (active === 'angel') deliver(name, { kind: 'option', token: t.token, time: t.time, ltp: t.ltp });
      },
    } : null,
  );
}

function notify() {
  for (const listener of listeners) listener();
}

function evaluate() {
  const upstox = upstoxFeedStatus();
  if (upstox.state === 'live') upstoxFailures = 0;
  // On Angel, stay until Upstox's feed is up again rather than switching back while it is still connecting
  const upstoxUsable =
    active === 'upstox'
      ? upstoxConfigured() && !upstox.refused && upstoxFailures < MAX_UPSTOX_FAILURES
      : upstox.state === 'live';
  const next = upstoxUsable ? 'upstox' : 'angel';
  if (next !== active) {
    active = next;
    console.log(next === 'angel' ? `Live data: Upstox unavailable (${upstox.message}), using Angel One.` : 'Live data: back on Upstox.');
    for (const name of watchers.keys()) syncWatcher(name);
  }
  notify();
}

onUpstoxFeedStatus((status) => {
  if (status.state === 'error') upstoxFailures += 1;
  evaluate();
});
onAngelFeedStatus(notify);

/**
 * Starts, changes or (with `spec` null) stops the ticks for `name`.
 * spec: { index: boolean (NIFTY 50), options: string[] (NSE tokens), onTick(tick) }
 */
export function watch(name, spec) {
  if (spec) watchers.set(name, spec);
  else watchers.delete(name);
  syncWatcher(name);
  evaluate(); // e.g. no Upstox token: fill in with Angel from the start
}

/** After an Angel One login: reconnect its feed if it is filling in, and let the pages know. */
export function reconnect() {
  reconnectAngel();
  notify();
}
