import crypto from 'node:crypto';
import os from 'node:os';

// Angel One SmartAPI, market data only: login and the option-greeks endpoint. Nothing here places orders.
// Credentials come from the environment: ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and, optionally,
// ANGEL_TOTP_SECRET. Without the secret, the current six-digit TOTP has to be entered in the app.

const ROOT = 'https://apiconnect.angelone.in';
const ROUTES = {
  login: '/rest/auth/angelbroking/user/v1/loginByPassword',
  refresh: '/rest/auth/angelbroking/jwt/v1/generateTokens',
  optionGreek: '/rest/secure/angelbroking/marketData/v1/optionGreek',
};
// Invalid / expired / missing session token
const TOKEN_ERRORS = new Set(['AG8001', 'AG8002', 'AG8003']);
const NO_DATA = 'AB9019';
const TIMEOUT_MS = 15_000;

export class AngelError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let session = null; // { jwt, refreshToken }
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
  session = { jwt: data.jwtToken, refreshToken: data.refreshToken };
  autoLoginFailed = false;
}

function needsLogin(message = 'Log in to Angel One with your TOTP to get live greeks.') {
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
    session = { jwt: data.jwtToken, refreshToken: data.refreshToken ?? session.refreshToken };
  } catch (err) {
    if (err.code === 'NETWORK') throw err;
    session = null;
    await ensureSession();
  }
}

/**
 * Greeks for every listed strike of `name` (e.g. NIFTY) expiring on `expiry` (e.g. 27OCT2026):
 * [{ strike, type: 'CE' | 'PE', delta, iv }]. Empty when Angel has no data for that expiry.
 */
export async function optionGreeks(name, expiry) {
  await ensureSession();
  let data;
  try {
    data = await post(ROUTES.optionGreek, { name, expirydate: expiry }, session.jwt);
  } catch (err) {
    if (err.code === NO_DATA) return [];
    if (!TOKEN_ERRORS.has(err.code)) throw err;
    await renewSession();
    data = await post(ROUTES.optionGreek, { name, expirydate: expiry }, session.jwt);
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
