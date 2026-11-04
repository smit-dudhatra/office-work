import { nfoLtps, optionGreeks } from './angel.js';
import { niftyOptionTokens } from './instruments.js';
import { feedStatus, onSourceChange, sourceInfo, watch } from './feed.js';
import { marketOpen } from './market.js';

// Live option deltas and prices for the browser, as server-sent events on one stream per page:
// - `greeks`: on Upstox, the delta that comes with each tick of the page's strikes. On the Angel One fallback, a
//   poll of its option-greeks endpoint for every expiry an open page asks for (Angel has no greeks stream).
// - `ltps`: prices of the strikes a page holds, tick by tick from the live feed (see feed.js). Upstox sends a
//   snapshot of each when it subscribes, so prices show outside market hours too; on Angel one REST quote does.
// - `status` (greeks, with the source in use) and `feed` (the live feed).

const UNDERLYING = 'NIFTY';
// One request returns the whole chain for an expiry. Angel publishes no limit for this endpoint.
const POLL_MS = Math.max(1, Number(process.env.ANGEL_GREEKS_POLL_SECONDS) || 3) * 1000;
const CLOSED_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const PUSH_MS = 250; // price changes reach a page at most four times a second
const EXPIRY_RE = /^\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}$/;
const MAX_EXPIRIES = 10;
// "27OCT2026:22050PE", an option to get the price of
const QUOTE_RE = /^(\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}):(\d+(?:\.\d+)?)(CE|PE)$/;
const MAX_QUOTES = 200;

const clients = new Set(); // { res, expiries: Set<string>, quotes: Map<expiry, Set<'22050PE'>> }
const latest = new Map(); // expiry → last `greeks` payload
let status = { state: 'connecting', message: '', ...sourceInfo() };
let timer = null;
let polling = false;
let backoff = 0;

const prices = new Map(); // expiry → Map<'22050PE', price | null>; null when Angel has no price for it
let optionTokens = new Map(); // NSE token → [expiry, '22050PE']
const changed = new Map(); // expiry → strikes whose price changed since the last push
const tickGreeks = new Map(); // expiry → Map<'22050PE', { delta, iv }>, from Upstox ticks
const greeksChanged = new Set(); // expiries whose tick greeks changed since the last push
let pushTimer = null;
let syncing = Promise.resolve();

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setStatus(state, message = '') {
  const next = { state, message, ...sourceInfo() };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const client of clients) send(client, 'status', status);
}

const onUpstox = () => sourceInfo().source === 'upstox';

/** On Upstox the greeks come with the ticks, so their status is the feed's. */
function setStatusFromFeed() {
  const feed = feedStatus();
  if (feed.state === 'live') setStatus(marketOpen() ? 'live' : 'closed');
  else setStatus(feed.state === 'idle' ? 'connecting' : feed.state, feed.message);
}

onSourceChange(() => {
  if (!clients.size) return;
  for (const client of clients) send(client, 'feed', feedStatus());
  if (onUpstox()) {
    clearTimeout(timer);
    timer = null;
    setStatusFromFeed();
  } else {
    setStatus(status.state, status.message); // carries the new source
    if (!timer && !polling) schedule(0); // back on Angel: poll the greeks again
  }
});

function wantedExpiries() {
  return new Set([...clients].flatMap((client) => [...client.expiries]));
}

/** expiry → strikes ('22050PE') whose price some open page wants. */
function wantedQuotes() {
  const wanted = new Map();
  for (const client of clients) {
    for (const [expiry, keys] of client.quotes) {
      if (!wanted.has(expiry)) wanted.set(expiry, new Set());
      for (const key of keys) wanted.get(expiry).add(key);
    }
  }
  return wanted;
}

function unpriced() {
  return [...wantedQuotes()].some(([expiry, keys]) => [...keys].some((key) => !prices.get(expiry)?.has(key)));
}

function pushPrices() {
  pushTimer = null;
  for (const [expiry, keys] of changed) {
    const ltps = Object.fromEntries([...keys].map((key) => [key, prices.get(expiry)?.get(key) ?? null]));
    for (const client of clients) if (client.expiries.has(expiry)) send(client, 'ltps', { expiry, ltps });
  }
  changed.clear();
  for (const expiry of greeksChanged) {
    // The last page holding this expiry may have closed since the tick (syncQuotes then forgets its greeks)
    const known = tickGreeks.get(expiry);
    if (!known) continue;
    const payload = { expiry, fetchedAt: new Date().toISOString(), strikes: Object.fromEntries(known) };
    latest.set(expiry, payload);
    for (const client of clients) if (client.expiries.has(expiry)) send(client, 'greeks', payload);
  }
  greeksChanged.clear();
}

function setPrice(expiry, key, price) {
  if (!prices.has(expiry)) prices.set(expiry, new Map());
  const known = prices.get(expiry);
  if (known.has(key) && known.get(key) === price) return;
  known.set(key, price);
  if (!changed.has(expiry)) changed.set(expiry, new Set());
  changed.get(expiry).add(key);
  pushTimer ??= setTimeout(pushPrices, PUSH_MS);
}

function onTick(tick) {
  const option = tick.kind === 'option' && optionTokens.get(tick.token);
  if (!option) return;
  const [expiry, key] = option;
  if (tick.ltp > 0) setPrice(expiry, key, tick.ltp);
  if (tick.delta === undefined) return;
  // Put deltas are negative; don't depend on how the feed signs them
  const delta = key.endsWith('PE') ? -Math.abs(tick.delta) : Math.abs(tick.delta);
  if (!tickGreeks.has(expiry)) tickGreeks.set(expiry, new Map());
  tickGreeks.get(expiry).set(key, { delta, iv: tick.iv ?? null });
  greeksChanged.add(expiry);
  pushTimer ??= setTimeout(pushPrices, PUSH_MS);
}

/** Watches the wanted strikes on the WebSocket and prices new ones over REST. */
async function syncQuotesNow() {
  const wanted = wantedQuotes();
  // Forget strikes no page holds, so a price is never older than the page that shows it
  for (const [expiry, known] of prices) {
    for (const key of known.keys()) if (!wanted.get(expiry)?.has(key)) known.delete(key);
    if (!known.size) prices.delete(expiry);
  }
  for (const [expiry, known] of tickGreeks) {
    for (const key of known.keys()) if (!wanted.get(expiry)?.has(key)) known.delete(key);
    if (!known.size) tickGreeks.delete(expiry);
  }
  if (!wanted.size) {
    optionTokens = new Map();
    watch('options', null);
    return;
  }

  const lookup = await niftyOptionTokens();
  const tokens = new Map();
  for (const [expiry, keys] of wanted) {
    for (const key of keys) {
      const token = lookup(expiry, key);
      if (token) tokens.set(token, [expiry, key]);
      else setPrice(expiry, key, null); // not listed by Angel
    }
  }
  optionTokens = tokens;
  watch('options', { options: [...tokens.keys()], onTick });

  // Upstox sends a snapshot of each strike when it subscribes
  const unseeded = [...tokens].filter(([, [expiry, key]]) => !prices.get(expiry)?.has(key));
  if (!unseeded.length || onUpstox()) return;
  const ltps = await nfoLtps(unseeded.map(([token]) => token));
  for (const [token, [expiry, key]] of unseeded) {
    // A tick that arrived meanwhile is newer than this quote
    if (!prices.get(expiry)?.has(key)) setPrice(expiry, key, ltps.get(token) ?? null);
  }
}

/** One sync at a time. Failures are retried by the next poll, which re-syncs while a strike has no price. */
function syncQuotes() {
  syncing = syncing.then(syncQuotesNow).catch((err) => {
    if (err.code !== 'NEEDS_LOGIN') console.error(`Option prices: ${err.message}`);
  });
}

function schedule(delay) {
  clearTimeout(timer);
  timer = clients.size ? setTimeout(poll, delay) : null;
}

async function poll() {
  timer = null;
  if (polling) return;
  if (onUpstox()) {
    setStatusFromFeed(); // the source change handler polls again once Angel is back
    return;
  }
  polling = true;
  let delay = marketOpen() ? POLL_MS : CLOSED_POLL_MS;
  try {
    for (const expiry of wantedExpiries()) {
      const strikes = {};
      for (const { strike, type, delta, iv } of await optionGreeks(UNDERLYING, expiry)) {
        strikes[`${strike}${type}`] = { delta, iv };
      }
      const payload = { expiry, fetchedAt: new Date().toISOString(), strikes };
      latest.set(expiry, payload);
      for (const client of clients) if (client.expiries.has(expiry)) send(client, 'greeks', payload);
    }
    backoff = 0;
    setStatus(marketOpen() ? 'live' : 'closed');
    if (unpriced()) syncQuotes();
    // A page asked for another expiry while this poll was running
    if ([...wantedExpiries()].some((expiry) => !latest.has(expiry))) delay = 0;
  } catch (err) {
    if (err.code === 'NEEDS_LOGIN') {
      // Polling resumes after a login (see refreshGreeks)
      setStatus('needs-login', err.message);
      return;
    }
    backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : POLL_MS * 2);
    delay = Math.max(delay, backoff);
    setStatus('error', `${err.message || 'Could not get greeks.'} Retrying in ${Math.round(delay / 1000)}s.`);
  } finally {
    polling = false;
  }
  schedule(delay);
}

/** Poll now, e.g. after a login. */
export function refreshGreeks() {
  setStatus('connecting');
  schedule(0);
  syncQuotes();
}

/** GET /api/greeks/stream?expiries=27OCT2026,03NOV2026&quotes=27OCT2026:22050PE,03NOV2026:24850CE */
export function streamGreeks(req, res) {
  const expiries = String(req.query.expiries ?? '')
    .toUpperCase()
    .split(',')
    .filter((expiry) => EXPIRY_RE.test(expiry))
    .slice(0, MAX_EXPIRIES);
  if (!expiries.length) {
    res.status(400).json({ error: 'Give one or more expiries like 27OCT2026.' });
    return;
  }

  const quotes = new Map();
  for (const item of String(req.query.quotes ?? '').toUpperCase().split(',').slice(0, MAX_QUOTES)) {
    const [, expiry, strike, type] = item.match(QUOTE_RE) ?? [];
    // Prices go to the pages that hold their expiry, so it has to be one this page asked for
    if (!expiry || !expiries.includes(expiry)) continue;
    if (!quotes.has(expiry)) quotes.set(expiry, new Set());
    quotes.get(expiry).add(`${Number(strike)}${type}`);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { res, expiries: new Set(expiries), quotes };
  clients.add(client);
  send(client, 'status', status);
  send(client, 'feed', feedStatus());
  for (const expiry of expiries) {
    if (latest.has(expiry)) send(client, 'greeks', latest.get(expiry));
    const known = prices.get(expiry);
    if (known?.size) send(client, 'ltps', { expiry, ltps: Object.fromEntries(known) });
  }
  // Comments keep idle connections (and the dev proxy) open
  const heartbeat = setInterval(() => res.write(':\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    if (!clients.size) schedule(0); // stops polling
    syncQuotes();
  });
  // Fetch a new expiry now rather than at the next (possibly minute-long) interval
  if (!polling && (!timer || expiries.some((expiry) => !latest.has(expiry)))) schedule(0);
  syncQuotes();
}
