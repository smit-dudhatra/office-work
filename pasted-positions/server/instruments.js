import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AngelError } from './angel.js';
import { istDate } from './market.js';

// Angel One's symbol tokens for NIFTY options, from the public instrument master. The file is shared with
// angel_nifty_oi.py (same name, folder above this app) and is downloaded again when it wasn't written today.

const MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const MASTER_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../OpenAPIScripMaster.json');
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** An expiry in Angel's format, e.g. 27OCT2026. */
export const EXPIRY_RE = /^\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}$/;

let tokens = null; // Map<'27OCT2026|22050PE', token>
let lotSizes = null; // Map<'27OCT2026', lot size>
let loadedOn = ''; // IST date the maps were built for
let loading = null;

function writtenToday(file) {
  try {
    return istDate(fs.statSync(file).mtimeMs) === istDate();
  } catch {
    return false;
  }
}

async function download() {
  const response = await fetch(MASTER_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const partial = `${MASTER_FILE}.part`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, MASTER_FILE);
}

/** NIFTY option tokens by expiry and strike, and the lot size of each expiry (every strike of one has the same). */
function indexNiftyOptions(rows) {
  const index = new Map();
  const lots = new Map();
  for (const row of rows) {
    if (row.exch_seg !== 'NFO' || row.name !== 'NIFTY' || row.instrumenttype !== 'OPTIDX' || !row.token) continue;
    const type = String(row.symbol).slice(-2);
    const strike = Number(row.strike) / 100; // the master lists strikes × 100
    if ((type !== 'CE' && type !== 'PE') || !(strike > 0)) continue;
    index.set(`${row.expiry}|${strike}${type}`, String(row.token));
    const lotSize = Number(row.lotsize);
    if (lotSize > 0 && !lots.has(row.expiry)) lots.set(row.expiry, lotSize);
  }
  return { index, lots };
}

async function load() {
  if (!writtenToday(MASTER_FILE)) {
    try {
      await download();
    } catch (err) {
      // An older copy still has every token that was listed then
      if (!fs.existsSync(MASTER_FILE)) {
        throw new AngelError(`Cannot download Angel One's instrument list (${err.message}).`, 'INSTRUMENTS');
      }
    }
  }
  ({ index: tokens, lots: lotSizes } = indexNiftyOptions(JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'))));
  loadedOn = istDate();
}

async function ensureLoaded() {
  if (tokens && loadedOn === istDate()) return;
  loading ??= load().finally(() => {
    loading = null;
  });
  await loading;
}

/** Token lookup for NIFTY options: (await niftyOptionTokens())('03NOV2026', '24850CE') → '54274', or undefined when not listed. */
export async function niftyOptionTokens() {
  await ensureLoaded();
  return (expiry, strikeAndType) => tokens.get(`${expiry}|${strikeAndType}`);
}

/** Lot size of NIFTY options by expiry: (await niftyLotSizes())('03NOV2026') → 65, or undefined when not listed. */
export async function niftyLotSizes() {
  await ensureLoaded();
  return (expiry) => lotSizes.get(expiry);
}
