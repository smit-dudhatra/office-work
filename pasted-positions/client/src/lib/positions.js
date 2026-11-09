// Option positions in a pasted sheet: the columns holding expiry, strike, CE / PE and quantity,
// the side of each row (BUY when most of the row is filled yellow, SELL otherwise) and, for live P&L,
// the Buy Price / Sell Price columns. A BUY's entry is its buy price and a SELL's its sell price; the other
// price column is where the live LTP goes.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const OPTION_TYPES = { CE: 'CE', CALL: 'CE', PE: 'PE', PUT: 'PE' };
const PRICE_WORD = '(?:price|avg|average|rate)';
const sidePriceRe = (side) => new RegExp(`\\b${side}\\b.*\\b${PRICE_WORD}\\b|\\b${PRICE_WORD}\\b.*\\b${side}\\b`, 'i');
const BUY_PRICE_RE = sidePriceRe('buy');
const SELL_PRICE_RE = sidePriceRe('sell');
export const PNL_COLUMN_RE = /^(?:p\s*[&/]\s*l|pnl)$/i;
export const LOTS_COLUMN_RE = /^(?:no\.?\s*(?:of\s*)?lots?|lots)$/i;

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

/**
 * "27-Oct", "27 Oct 2026", "27OCT26", "2026-10-27" or "27/10/2026" → "27OCT2026" (Angel's format).
 * Without a year, the 27-Oct nearest to `today` is used.
 */
export function expiryCode(text, today = new Date()) {
  const s = String(text).trim();
  let day;
  let month;
  let year;
  let m;
  if ((m = s.match(/^(\d{1,2})[\s./-]*([a-z]{3})[a-z]*\.?(?:[\s./,-]*(\d{4}|\d{2}))?$/i))) {
    [day, month, year] = [Number(m[1]), MONTHS.indexOf(m[2].toUpperCase()), m[3]];
  } else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [year, month, day] = [m[1], Number(m[2]) - 1, Number(m[3])];
  } else if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/))) {
    // Day first (Indian format); month first only when day first is impossible
    const [a, b] = [Number(m[1]), Number(m[2])];
    [day, month, year] = b <= 12 ? [a, b - 1, m[3]] : [b, a - 1, m[3]];
  } else {
    return null;
  }
  if (month < 0) return null;

  let date;
  if (year !== undefined) {
    date = validDate(year.length === 2 ? 2000 + Number(year) : Number(year), month, day);
  } else {
    const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    date = [-1, 0, 1]
      .map((offset) => validDate(today.getFullYear() + offset, month, day))
      .filter(Boolean)
      .sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
  }
  if (!date) return null;
  return `${String(date.getUTCDate()).padStart(2, '0')}${MONTHS[date.getUTCMonth()]}${date.getUTCFullYear()}`;
}

/** Excel yellows (#FFFF00, #FFFF99, #FFFFCC…), not gold or orange. */
export function isYellow(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return false;
  const lightness = (max + min) / 2;
  const saturation = d / (1 - Math.abs(2 * lightness - 1));
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 50 && hue <= 70 && saturation >= 0.5 && lightness >= 0.35 && lightness <= 0.92;
}

function findColumns(columns, rows) {
  const byLabel = (re, type = 'number') => columns.findIndex((c) => re.test(c.label.trim()) && c.type === type);
  // The CE / PE column can be called anything (Symbol, Type, Option…), so look at the values
  const optionType = columns.findIndex(
    (c, i) =>
      c.type === 'text' &&
      rows.some((row) => row[i] !== '') &&
      rows.every((row) => row[i] === '' || String(row[i]).toUpperCase() in OPTION_TYPES),
  );
  return {
    expiry: columns.findIndex((c) => /expir/i.test(c.label)),
    strike: byLabel(/strike/i),
    optionType,
    quantity: byLabel(/^(?:total\s*lot\s*size|qty|quantity|net\s*qty)$/i),
    lotSize: byLabel(/^lot\s*size$/i),
    lots: byLabel(LOTS_COLUMN_RE),
    buyPrice: byLabel(BUY_PRICE_RE),
    sellPrice: byLabel(SELL_PRICE_RE),
    pnl: byLabel(PNL_COLUMN_RE),
  };
}

/**
 * Profit or loss of a position at `ltp` (null when the entry price or the LTP is missing).
 * `buy` is the side to use, which may differ from `position.buy` when the user flipped the row.
 */
export function pnlAt(position, buy, ltp) {
  const entry = buy ? position.buyPrice : position.sellPrice;
  if (entry === null || ltp === null) return null;
  return (buy ? ltp - entry : entry - ltp) * position.quantity;
}

/** "27OCT2026" → 20261027, so expiries sort by date ("01DEC2026" after "09NOV2026"). */
export function expiryOrder(code) {
  return Number(code.slice(5)) * 10_000 + (MONTHS.indexOf(code.slice(2, 5)) + 1) * 100 + Number(code.slice(0, 2));
}

/** "27OCT2026" → "27 Oct". */
export function expiryLabel(code) {
  return `${code.slice(0, 2)} ${code.slice(2, 3)}${code.slice(3, 5).toLowerCase()}`;
}

/** An out-of-the-money option counts as worth this much at expiry, not nothing. */
export const OTM_EXPIRY_VALUE = 1;

/**
 * What an option is worth if NIFTY settles at `spot` on its expiry: its in-the-money amount (CE: spot − strike,
 * PE: strike − spot), or ₹1.00 when that is less (out of the money, at the money, or less than a rupee in).
 */
export function expiryValue(position, spot) {
  const inTheMoney = position.type === 'CE' ? spot - position.strike : position.strike - spot;
  return Math.max(inTheMoney, OTM_EXPIRY_VALUE);
}

/**
 * The positions in a sheet, or null when it doesn't look like a list of options:
 * { positions, prices }. `positions` has an entry per row, { expiry, strike, type, quantity, lotSize, buy,
 * buyPrice, sellPrice }, or null for a row that isn't a position. `prices` is { buy, sell, pnl } (column
 * indexes; pnl is null without a P&L column), or null when the sheet has no Buy Price and Sell Price columns.
 */
export function readPositions(sheet) {
  const { columns, rows, fills } = sheet;
  const col = findColumns(columns, rows);
  const hasQuantity = col.quantity >= 0 || (col.lots >= 0 && col.lotSize >= 0);
  if (col.expiry < 0 || col.strike < 0 || col.optionType < 0 || !hasQuantity) return null;
  const prices =
    col.buyPrice >= 0 && col.sellPrice >= 0
      ? { buy: col.buyPrice, sell: col.sellPrice, pnl: col.pnl >= 0 ? col.pnl : null }
      : null;
  const priceAt = (row, index) => (prices && Number.isFinite(row[index]) ? row[index] : null);

  const positions = rows.map((row, i) => {
    const expiry = expiryCode(row[col.expiry]);
    const strike = row[col.strike];
    const type = OPTION_TYPES[String(row[col.optionType]).toUpperCase()];
    const lotSize = col.lotSize >= 0 ? row[col.lotSize] : null;
    const quantity = col.quantity >= 0 ? row[col.quantity] : row[col.lots] * lotSize;
    if (!expiry || !type || !Number.isFinite(strike) || !Number.isFinite(quantity) || !quantity) return null;
    const yellow = (fills?.[i] ?? []).filter((fill) => fill && isYellow(fill)).length;
    return {
      expiry,
      strike,
      type,
      quantity: Math.abs(quantity),
      lotSize: lotSize || null,
      buy: yellow * 2 > row.length,
      buyPrice: priceAt(row, col.buyPrice),
      sellPrice: priceAt(row, col.sellPrice),
    };
  });
  return positions.some(Boolean) ? { positions, prices } : null;
}
