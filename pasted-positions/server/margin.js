import { ANGEL_MARGIN_LIMIT, AngelError, nfoMargin } from './angel.js';
import { EXPIRY_RE, niftyOptionTokens } from './instruments.js';
import { UPSTOX_MARGIN_LIMIT, upstoxMargin } from './upstox.js';

// The margin the pasted NIFTY option positions need, NRML. A broker counts hedges only between options in the same
// request, so all of them go in one request when one source takes that many:
//   up to 20 options: Upstox, else Angel One;   21–50: Angel One.
// Otherwise (more than 50, or Angel One not logged in) they are split across several Upstox requests (Angel One's
// if Upstox fails) and added up. That total is an upper bound: hedges across requests aren't counted.

const MAX_ROWS = 500;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

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

/** 27OCT2026 → 20261027, for sorting. */
function expiryOrder(expiry) {
  return Number(expiry.slice(5)) * 10_000 + (MONTHS.indexOf(expiry.slice(2, 5)) + 1) * 100 + Number(expiry.slice(0, 2));
}

/** `items` cut into the fewest runs of at most `limit`, as even as possible. */
function evenChunks(items, limit) {
  if (!items.length) return [];
  const size = Math.ceil(items.length / Math.ceil(items.length / limit));
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Legs in requests of at most `limit`, keeping hedges together where it can, since a hedge only counts within a
 * request. Each expiry stays whole when it fits. A bigger one is split into its PE and CE legs, so vertical spreads
 * stay together (only the PE–CE offset is lost), and a side that is still too big is cut into runs of neighbouring
 * strikes. The pieces then share requests in expiry order while they fit.
 */
export function marginBatches(legs, limit) {
  const byExpiry = new Map();
  for (const leg of [...legs].sort((a, b) => expiryOrder(a.expiry) - expiryOrder(b.expiry))) {
    if (!byExpiry.has(leg.expiry)) byExpiry.set(leg.expiry, []);
    byExpiry.get(leg.expiry).push(leg);
  }
  const pieces = [];
  for (const group of byExpiry.values()) {
    if (group.length <= limit) {
      pieces.push(group);
      continue;
    }
    for (const type of ['PE', 'CE']) {
      const side = group.filter((leg) => leg.type === type).sort((a, b) => a.strike - b.strike);
      pieces.push(...evenChunks(side, limit));
    }
  }
  const batches = [];
  for (const piece of pieces) {
    const last = batches[batches.length - 1];
    if (last && last.length + piece.length <= limit) last.push(...piece);
    else batches.push([...piece]);
  }
  return batches;
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
  upstox: { name: 'Upstox', limit: UPSTOX_MARGIN_LIMIT, margin: upstoxMargin },
  angel: { name: 'Angel One', limit: ANGEL_MARGIN_LIMIT, margin: angelMargin },
};

/** The margin of `legs` from `source`, split into requests that source takes, and added up. */
async function splitMargin(source, legs) {
  const { limit, margin } = SOURCES[source];
  const parts = [];
  // One at a time, to stay well inside the brokers' rate limits
  for (const batch of marginBatches(legs, limit)) parts.push(await margin(batch));
  const total = (key) => (parts.some((part) => part[key] === null) ? null : parts.reduce((sum, part) => sum + part[key], 0));
  return {
    required: total('required'),
    final: total('final'),
    span: total('span'),
    exposure: total('exposure'),
    premium: total('premium'),
    requests: parts.length,
  };
}

/**
 * Margin of `rows` (see readRow): { source: 'upstox' | 'angel' | null, approximate, requests, required, final,
 * benefit, span, exposure, premium, legs, missing, skipped, at }.
 * - `approximate` is true when the legs were split across `requests` requests; `final` is then an upper bound.
 * - `source` is null when nothing needs margin (no legs left after netting).
 * - `skipped` says why a better source wasn't used: [{ source: 'Upstox' | 'Angel One', reason }].
 */
export async function positionsMargin(rows) {
  const { legs, missing } = await netLegs(rows);
  const result = { legs: legs.length, missing, skipped: [], at: new Date().toISOString() };
  if (!legs.length) {
    return { ...result, source: null, approximate: false, requests: 0, required: 0, final: 0, benefit: 0, span: 0, exposure: 0, premium: 0 };
  }

  // Exact (one request) where a source takes this many legs, else split; each step only when the last one failed
  const steps = [
    { source: 'upstox', split: false },
    { source: 'angel', split: false },
    { source: 'upstox', split: true },
    { source: 'angel', split: true },
  ].filter(({ source, split }) => split === (legs.length > SOURCES[source].limit));
  for (const { source, split } of steps) {
    try {
      const margin = split ? await splitMargin(source, legs) : { ...(await SOURCES[source].margin(legs)), requests: 1 };
      return {
        ...result,
        source,
        approximate: split,
        ...margin,
        benefit: Math.max(0, margin.required - margin.final),
      };
    } catch (err) {
      result.skipped.push({ source: SOURCES[source].name, reason: err.message });
    }
  }
  throw new MarginError(result.skipped.map(({ source, reason }) => `${source}: ${reason}`).join(' '), 502);
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
