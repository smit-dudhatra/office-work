import crypto from 'node:crypto';
import os from 'node:os';

// Angel One SmartAPI, market data only: login, option greeks, quotes and daily candles. Nothing here places orders.
// Credentials come from the environment: ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and, optionally,
// ANGEL_TOTP_SECRET. Without the secret, the current six-digit TOTP has to be entered in the app.

const ROOT = 'https://apiconnect.angelone.in';
const ROUTES = {
  login: '/rest/auth/angelbroking/user/v1/loginByPassword',
  refresh: '/rest/auth/angelbroking/jwt/v1/generateTokens',
  optionGreek: '/rest/secure/angelbroking/marketData/v1/optionGreek',
  quote: '/rest/secure/angelbroking/market/v1/quote/',
  candles: '/rest/secure/angelbroking/historical/v1/getCandleData',
};
// Invalid / expired / missing session token
const TOKEN_ERRORS = new Set(['AG8001', 'AG8002', 'AG8003']);
const NO_DATA = 'AB9019';
const TIMEOUT_MS = 15_000;
// The quote endpoint takes at most 50 tokens per request, and about one request a second
const QUOTE_BATCH = 50;
const QUOTE_GAP_MS = 1_100;
// Angel sometimes sends an empty reply to a candle request; a later try usually works
const CANDLE_ATTEMPTS = 3;

export class AngelError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let session = null; // { jwt, refreshToken, feedToken }
// A rejected automatic login is not retried, so a wrong TOTP secret can't lock the account
let autoLoginFailed = false;

const MAC_ADDRESS =
  Object.values(os.networkInterfaces())
    .flat()
    .find((nic) => nic && !nic.internal && nic.mac !== '00:00:00:00:00:00')?.mac ?? '00:00:00:00:00:00';

function credentials() {
  const value = (name) => process.env[name]?.trim() ?? '';
  return {
    apiKey: value('ANGEL_API_KEY'),
    clientCode: value('ANGEL_CLIENT_CODE'),
    pin: value('ANGEL_PIN'),
    totpSecret: value('ANGEL_TOTP_SECRET'),
  };
}

function headers(apiKey, jwt) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': MAC_ADDRESS,
    'X-PrivateKey': apiKey,
    ...(jwt && { Authorization: `Bearer ${jwt}` }),
  };
}

async function post(route, body, jwt) {
  let response;
  try {
    response = await fetch(ROOT + route, {
      method: 'POST',
      headers: headers(credentials().apiKey, jwt),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AngelError('Cannot reach Angel One.', 'NETWORK');
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Rate limiting comes back as plain text
  }
  if (!data) {
    const limited = response.status === 429 || /rate|exceed/i.test(text);
    throw new AngelError(
      limited ? 'Angel One is rate limiting requests.' : `Angel One returned HTTP ${response.status}.`,
      limited ? 'RATE_LIMIT' : 'HTTP',
    );
  }
  const code = data.errorcode || data.errorCode || '';
  if (data.status === false || data.success === false || TOKEN_ERRORS.has(code)) {
    throw new AngelError(data.message || 'Angel One rejected the request.', code);
  }
  return data.data;
}

function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/[\s=]/g, '').toUpperCase()) {
    const value = alphabet.indexOf(ch);
    if (value < 0) throw new AngelError('ANGEL_TOTP_SECRET is not a valid base32 secret.', 'CONFIG');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 six-digit code (30 s step, SHA-1), the same as an authenticator app shows. */
export function totpCode(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hash = crypto.createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = hash[hash.length - 1] & 0xf;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function angelStatus() {
  const { apiKey, clientCode, pin, totpSecret } = credentials();
  return {
    configured: Boolean(apiKey && clientCode && pin),
    loggedIn: Boolean(session),
    autoLogin: Boolean(totpSecret) && !autoLoginFailed,
  };
}

/** Log in with `totp`, or with a code from ANGEL_TOTP_SECRET when `totp` is not given. */
export async function login(totp) {
  const { apiKey, clientCode, pin, totpSecret } = credentials();
  if (!apiKey || !clientCode || !pin) {
    throw new AngelError('Set ANGEL_API_KEY, ANGEL_CLIENT_CODE and ANGEL_PIN in .env, then restart the server.', 'CONFIG');
  }
  const code = totp ?? (totpSecret ? totpCode(totpSecret) : '');
  if (!/^\d{6}$/.test(code)) throw new AngelError('Enter the six-digit TOTP from your authenticator app.', 'TOTP');

  const data = await post(ROUTES.login, { clientcode: clientCode, password: pin, totp: code });
  if (!data?.jwtToken) throw new AngelError('Angel One login returned no session.', 'LOGIN');
  session = { jwt: data.jwtToken, refreshToken: data.refreshToken, feedToken: data.feedToken };
  autoLoginFailed = false;
}

function needsLogin(message = 'Log in to Angel One with your TOTP to get live data.') {
  return new AngelError(message, 'NEEDS_LOGIN');
}

async function ensureSession() {
  if (session) return;
  if (!angelStatus().autoLogin) throw needsLogin();
  try {
    await login();
  } catch (err) {
    if (err.code === 'NETWORK' || err.code === 'RATE_LIMIT') throw err;
    autoLoginFailed = true;
    throw needsLogin(`Automatic login failed (${err.message}). Enter the TOTP to log in.`);
  }
}

async function renewSession() {
  try {
    const data = await post(ROUTES.refresh, { refreshToken: session.refreshToken }, session.jwt);
    if (!data?.jwtToken) throw new AngelError('No token', 'LOGIN');
    session = {
      jwt: data.jwtToken,
      refreshToken: data.refreshToken ?? session.refreshToken,
      feedToken: data.feedToken ?? session.feedToken,
    };
  } catch (err) {
    if (err.code === 'NETWORK') throw err;
    session = null;
    await ensureSession();
  }
}

/** What the SmartStream WebSocket needs to connect: { jwt, feedToken, apiKey, clientCode }. */
export async function streamCredentials() {
  await ensureSession();
  if (!session.feedToken) throw new AngelError('Angel One login returned no feed token.', 'LOGIN');
  const { apiKey, clientCode } = credentials();
  return { jwt: session.jwt, feedToken: session.feedToken, apiKey, clientCode };
}

/** POST with the session, renewing it once if Angel says the token is no longer valid. */
async function securePost(route, body) {
  await ensureSession();
  try {
    return await post(route, body, session.jwt);
  } catch (err) {
    if (!TOKEN_ERRORS.has(err.code)) throw err;
    await renewSession();
    return post(route, body, session.jwt);
  }
}

/**
 * Greeks for every listed strike of `name` (e.g. NIFTY) expiring on `expiry` (e.g. 27OCT2026):
 * [{ strike, type: 'CE' | 'PE', delta, iv }]. Empty when Angel has no data for that expiry.
 */
export async function optionGreeks(name, expiry) {
  let data;
  try {
    data = await securePost(ROUTES.optionGreek, { name, expirydate: expiry });
  } catch (err) {
    if (err.code === NO_DATA) return [];
    throw err;
  }
  return (Array.isArray(data) ? data : [])
    .map((row) => {
      const type = String(row.optionType).toUpperCase();
      const delta = Number(row.delta);
      return {
        strike: Number(row.strikePrice),
        type,
        // Put deltas are negative; don't depend on how the API signs them
        delta: type === 'PE' ? -Math.abs(delta) : Math.abs(delta),
        iv: Number(row.impliedVolatility),
      };
    })
    .filter((row) => (row.type === 'CE' || row.type === 'PE') && Number.isFinite(row.strike) && Number.isFinite(row.delta));
}

/** Quote rows (`mode` LTP, OHLC or FULL) for tokens of one exchange, in batches of 50. */
async function quotes(mode, exchange, tokens) {
  const rows = [];
  for (let i = 0; i < tokens.length; i += QUOTE_BATCH) {
    if (i) await new Promise((resolve) => setTimeout(resolve, QUOTE_GAP_MS));
    const data = await securePost(ROUTES.quote, { mode, exchangeTokens: { [exchange]: tokens.slice(i, i + QUOTE_BATCH) } });
    rows.push(...(data?.fetched ?? []));
  }
  return rows;
}

/**
 * Last traded price of NFO instruments, by symbol token: Map<token, ltp>. A token Angel returns no
 * price for is left out of the map (outside market hours this is the last close).
 */
export async function nfoLtps(tokens) {
  const ltps = new Map();
  for (const { symbolToken, ltp } of await quotes('LTP', 'NFO', tokens)) {
    if (Number(ltp) > 0) ltps.set(String(symbolToken), Number(ltp));
  }
  return ltps;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * The day so far for an NSE instrument: { date: '2026-10-30', time, ltp, open, high, low, close } where
 * `close` is the previous close and `date` the session the quote belongs to (the last one when the market
 * is closed). Null when Angel returns nothing.
 */
export async function nseQuote(token) {
  const [row] = await quotes('FULL', 'NSE', [token]);
  if (!row || !(Number(row.ltp) > 0)) return null;
  // "30-Oct-2026 15:29:59"
  const m = String(row.exchFeedTime || row.exchTradeTime || '').match(/^(\d{1,2})-([a-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/i);
  const month = m ? MONTHS.indexOf(m[2].toUpperCase()) : -1;
  const time = month >= 0 ? Date.UTC(m[3], month, m[1], m[4], m[5], m[6]) - 330 * 60_000 : Date.now();
  return {
    date: new Date(time + 330 * 60_000).toISOString().slice(0, 10),
    time,
    ltp: Number(row.ltp),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  };
}

/** Daily candles of an instrument from `from` to `to` ("2026-10-30"), oldest first: [{ date, open, high, low, close }]. */
export async function dailyCandles(exchange, token, from, to) {
  for (let attempt = 1; ; attempt += 1) {
    let data;
    try {
      // Daily candles are stamped at midnight, so a 09:15 start would drop the first day
      data = await securePost(ROUTES.candles, {
        exchange,
        symboltoken: token,
        interval: 'ONE_DAY',
        fromdate: `${from} 00:00`,
        todate: `${to} 23:59`,
      });
    } catch (err) {
      if (err.code !== 'HTTP' || attempt >= CANDLE_ATTEMPTS) throw err;
      continue;
    }
    // Each row is [timestamp, open, high, low, close, volume], the timestamp like 2026-10-30T00:00:00+05:30
    return (Array.isArray(data) ? data : [])
      .map(([time, open, high, low, close]) => ({
        date: String(time).slice(0, 10),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
      }))
      .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every((value) => value > 0));
  }
}
