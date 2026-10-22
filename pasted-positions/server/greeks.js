import { optionGreeks } from './angel.js';

// Live option deltas for the browser: polls Angel One's option-greeks endpoint for every expiry that an
// open page asks for, and pushes the results as server-sent events (`status` and `greeks`).

const UNDERLYING = 'NIFTY';
// One request returns the whole chain for an expiry. Angel publishes no limit for this endpoint.
const POLL_MS = Math.max(1, Number(process.env.ANGEL_GREEKS_POLL_SECONDS) || 3) * 1000;
const CLOSED_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const EXPIRY_RE = /^\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}$/;
const MAX_EXPIRIES = 10;

const clients = new Set(); // { res, expiries: Set<string> }
const latest = new Map(); // expiry → last `greeks` payload
let status = { state: 'connecting', message: '' };
let timer = null;
let polling = false;
let backoff = 0;

/** NSE cash/F&O hours, 09:15–15:30 IST on weekdays (holidays aren't known here). */
function marketOpen(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const day = ist.getUTCDay();
  return day >= 1 && day <= 5 && minutes >= 555 && minutes <= 930;
}

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setStatus(state, message = '') {
  if (status.state === state && status.message === message) return;
  status = { state, message };
  for (const client of clients) send(client, 'status', status);
}

function wantedExpiries() {
  return new Set([...clients].flatMap((client) => [...client.expiries]));
}

function schedule(delay) {
  clearTimeout(timer);
  timer = clients.size ? setTimeout(poll, delay) : null;
}

async function poll() {
  timer = null;
  if (polling) return;
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
}

/** GET /api/greeks/stream?expiries=27OCT2026,03NOV2026 */
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { res, expiries: new Set(expiries) };
  clients.add(client);
  send(client, 'status', status);
  for (const expiry of expiries) if (latest.has(expiry)) send(client, 'greeks', latest.get(expiry));
  // Comments keep idle connections (and the dev proxy) open
  const heartbeat = setInterval(() => res.write(':\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    if (!clients.size) schedule(0); // stops polling
  });
  // Fetch a new expiry now rather than at the next (possibly minute-long) interval
  if (!polling && (!timer || expiries.some((expiry) => !latest.has(expiry)))) schedule(0);
}
