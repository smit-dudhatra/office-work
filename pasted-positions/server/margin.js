import { ANGEL_MARGIN_LIMIT, AngelError, nfoMargin } from './angel.js';
import { EXPIRY_RE, niftyOptionTokens } from './instruments.js';
import { UPSTOX_MARGIN_LIMIT, upstoxMargin } from './upstox.js';

// The margin the pasted NIFTY option positions need, NRML. A broker counts hedges only between options in the same
// request, so all of them always go in one request, by the number of legs (options left after netting):
//   up to 20: Upstox, or Angel One if Upstox fails;   21–50: Angel One only.
// More than 50, or 21–50 while Angel One isn't logged in, can't be worked out: the reply is an error saying why.

const MAX_ROWS = 500;

export class MarginError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A position from the page: { expiry: '27OCT2026', strike, type: 'CE' | 'PE', quantity, buy }, or null when invalid. */
function readRow(row) {
  const expiry = String(row?.expiry ?? '').toUpperCase();
  const strike = Number(row?.strike);
  const type = String(row?.type ?? '').toUpperCase();
  const quantity = Math.round(Math.abs(Number(row?.quantity)));
  if (!EXPIRY_RE.test(expiry) || !(strike > 0) || (type !== 'CE' && type !== 'PE') || !(quantity > 0)) return null;
  return { expiry, strike, type, quantity, buy: Boolean(row.buy) };
}

/**
 * One leg per option, with the net quantity of its rows: [{ token, expiry, strike, type, quantity, buy }]. A BUY
 * and a SELL of the same option offset each other, as they would in the account, and an option that nets to zero
 * drops out. `missing` counts the rows whose option Angel's instrument list doesn't have (e.g. expired).
 */
async function netLegs(rows) {
  const lookup = await niftyOptionTokens();
  const net = new Map(); // token → { expiry, strike, type, signed quantity (+ for BUY) }
  let missing = 0;
  for (const row of rows) {
    const token = lookup(row.expiry, `${row.strike}${row.type}`);
    if (!token) {
      missing += 1;
      continue;
    }
    if (!net.has(token)) net.set(token, { expiry: row.expiry, strike: row.strike, type: row.type, signed: 0 });
    net.get(token).signed += row.buy ? row.quantity : -row.quantity;
  }
  const legs = [...net]
    .filter(([, leg]) => leg.signed !== 0)
    .map(([token, { signed, ...leg }]) => ({ token, ...leg, quantity: Math.abs(signed), buy: signed > 0 }));
  return { legs, missing };
}

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** Angel's reply in Upstox's terms. It has no exposure figure; SPAN and premium are left out when it doesn't send them. */
async function angelMargin(legs) {
  const data = await nfoMargin(legs);
  const final = finite(data?.totalMarginRequired);
  if (final === null) throw new AngelError('Angel One returned no margin.', 'MARGIN');
  const parts = data.marginComponents ?? {};
  const benefit = finite(parts.marginBenefit) ?? 0;
  return {
    required: final + benefit,
    final,
    span: finite(parts.spanMargin),
    exposure: null,
    premium: finite(parts.totOptionsPremium ?? parts.netPremium),
  };
}

const SOURCES = {
  upstox: { name: 'Upstox', margin: upstoxMargin },
  angel: { name: 'Angel One', margin: angelMargin },
};

const notLoggedIn = (err) => err instanceof AngelError && err.code === 'NEEDS_LOGIN';

/**
 * Margin of `rows` (see readRow), all legs in one request: { source: 'upstox' | 'angel' | null, required, final,
 * benefit, span, exposure, premium, legs, missing, skipped, at }.
 * - `source` is null when nothing needs margin (no legs left after netting).
 * - `skipped` says why Upstox wasn't used when Angel One stood in for it: [{ source: 'Upstox', reason }].
 * Throws a MarginError when it can't be worked out: more than 50 legs, Angel One not logged in for 21–50, or every
 * source that takes this many failed.
 */
export async function positionsMargin(rows) {
  const { legs, missing } = await netLegs(rows);
  const result = { legs: legs.length, missing, skipped: [], at: new Date().toISOString() };
  if (!legs.length) {
    return { ...result, source: null, required: 0, final: 0, benefit: 0, span: 0, exposure: 0, premium: 0 };
  }
  if (legs.length > ANGEL_MARGIN_LIMIT) {
    throw new MarginError(
      `Can't calculate: ${legs.length} legs exceed the limit of ${ANGEL_MARGIN_LIMIT}, the most Angel One takes in one request.`,
    );
  }

  // Upstox first, Angel One if it fails, for up to 20 legs; only Angel One takes more
  const sources = legs.length <= UPSTOX_MARGIN_LIMIT ? ['upstox', 'angel'] : ['angel'];
  for (const source of sources) {
    try {
      const margin = await SOURCES[source].margin(legs);
      return { ...result, source, ...margin, benefit: Math.max(0, margin.required - margin.final) };
    } catch (err) {
      if (sources.length === 1 && notLoggedIn(err)) {
        throw new MarginError(
          `Can't calculate: Angel One login is not done. ${legs.length} legs need Angel One, since Upstox takes at ` +
            `most ${UPSTOX_MARGIN_LIMIT}. Log in with your TOTP.`,
          503,
        );
      }
      result.skipped.push({ source: SOURCES[source].name, reason: notLoggedIn(err) ? 'login is not done.' : err.message });
    }
  }
  throw new MarginError(`Can't calculate: ${result.skipped.map(({ source, reason }) => `${source}: ${reason}`).join(' ')}`, 502);
}

/** POST /api/margin with { positions: [{ expiry, strike, type, quantity, buy }] } */
export async function marginHandler(req, res) {
  const positions = req.body?.positions;
  if (!Array.isArray(positions) || positions.length > MAX_ROWS) {
    throw new MarginError(`Send up to ${MAX_ROWS} positions as { positions: [...] }.`);
  }
  const rows = positions.map(readRow);
  if (rows.some((row) => !row)) throw new MarginError('Each position needs an expiry like 27OCT2026, a strike, CE / PE and a quantity.');
  res.json(await positionsMargin(rows));
}
