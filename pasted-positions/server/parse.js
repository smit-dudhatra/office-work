import path from 'node:path';
import * as XLSX from 'xlsx';

/** Raised for bad input; the server turns it into a 400 with the message. */
export class ParseError extends Error {}

export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv', '.txt'];
const TEXT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

const MAX_DECIMALS = 4;
// Placeholders brokers use for "no value": -, --, —, NA, N/A
const BLANKISH_RE = /^(?:[-–—]+|n\/?a)$/i;
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
// 1,234.50 (western) and 12,34,567.89 (Indian) grouping
const GROUPED_RE = /^[+-]?\d{1,3}(?:,\d{2,3})+(?:\.\d*)?$/;
const CURRENCY_RE = /^([+-]?)(?:₹|rs\.?|inr|\$)/i;
// A "Total" row already present in the input would double count our own totals
const TOTAL_ROW_RE = /^(?:grand\s+)?totals?\s*:?$/i;

// ---------------------------------------------------------------- public API

/**
 * Parse text pasted from Excel (tab-separated) or a web page.
 * `html` is the clipboard's text/html, only used when the plain text has no tabs.
 */
export function parseText(text, html) {
  let grid = null;
  if (!text.includes('\t') && html && /<table/i.test(html)) grid = gridFromHtml(html);
  if (!grid?.length) grid = splitDelimited(text);

  const table = normalizeTable(grid, 'Pasted');
  if (!table) throw new ParseError('No data rows found. Copy the header row together with at least one row below it.');
  return { source: { kind: 'paste', name: 'Pasted data' }, sheets: [table] };
}

/** Parse an uploaded spreadsheet / CSV. Every non-empty sheet becomes a table. */
export function parseFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new ParseError(`Unsupported file type "${ext || filename}". Use ${ACCEPTED_EXTENSIONS.join(', ')}.`);
  }

  let sheets;
  if (TEXT_EXTENSIONS.has(ext)) {
    const table = normalizeTable(splitDelimited(decodeText(buffer)), path.basename(filename, ext));
    sheets = table ? [table] : [];
  } else {
    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, dateNF: 'dd-mmm-yyyy' });
    } catch {
      throw new ParseError('Could not read this file as a spreadsheet. Is it password-protected or corrupted?');
    }
    sheets = workbook.SheetNames
      .map((name) => normalizeTable(sheetToGrid(workbook.Sheets[name]), name))
      .filter(Boolean);
  }

  if (!sheets.length) throw new ParseError('No table data found in this file.');
  return { source: { kind: 'file', name: filename }, sheets };
}

// ------------------------------------------------------------- grid builders

function sheetToGrid(sheet) {
  // raw:false gives the text as Excel displays it, so number formats survive
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
}

function gridFromHtml(html) {
  try {
    const workbook = XLSX.read(html, { type: 'string', raw: true });
    return sheetToGrid(workbook.Sheets[workbook.SheetNames[0]]);
  } catch {
    return null;
  }
}

function decodeText(buffer) {
  // Excel's "Unicode Text" export is UTF-16LE with a BOM
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').slice(1);
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** Split delimited text into rows of cells, guessing the delimiter. */
function splitDelimited(text) {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
  if (!lines.length) return [];

  // Excel copies always use tabs
  if (clean.includes('\t')) return parseDelimited(clean, '\t');

  // A single copied column of formatted numbers ("1,234.50") must not be split on commas
  if (lines.slice(1).every((line) => parseNumber(line) !== null)) return lines.map((line) => [line]);

  for (const delimiter of [',', ';', '|']) {
    const grid = parseDelimited(clean, delimiter);
    if (looksTabular(grid)) return grid;
  }

  // Space-aligned text, e.g. copied from a terminal or PDF
  const spaced = lines.map((line) => line.trim().split(/\s{2,}/));
  if (looksTabular(spaced)) return spaced;

  return lines.map((line) => [line]);
}

function looksTabular(grid) {
  const rows = grid.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (!rows.length || rows[0].length < 2) return false;
  const width = rows[0].length;
  return rows.filter((row) => row.length === width).length / rows.length >= 0.8;
}

/** Quote-aware split (Excel quotes cells containing tabs, newlines or quotes). */
function parseDelimited(text, delimiter, honourQuotes = true) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = false;
    } else if (ch === '"' && field === '' && honourQuotes) {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // An unbalanced quote means the text wasn't really quoted (e.g. a stray " in a web copy)
  if (inQuotes) return parseDelimited(text, delimiter, false);
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------- normalisation

function cellText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/ /g, ' ').replace(/\r\n?/g, '\n').trim();
}

function isBlankish(text) {
  return text === '' || BLANKISH_RE.test(text);
}

/** "₹1,234.50", "(1,234)", "-12.5%" → { value, percent, decimals }; null if not a number. */
function parseNumber(text) {
  let s = text.replace(/\s/g, '');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/−/g, '-').replace(CURRENCY_RE, '$1');
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1);
  }
  if (s.includes(',')) {
    if (!GROUPED_RE.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  // Leading zeros usually mean an ID/code, keep those as text
  if (!NUMBER_RE.test(s) || /^[+-]?0\d/.test(s)) return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  const fraction = s.match(/\.(\d+)/);
  return { value: negative ? -value : value, percent, decimals: fraction ? fraction[1].length : 0 };
}

function uniqueLabels(labels) {
  const seen = new Map();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}

/**
 * Turn a raw 2-D grid of cells into { name, columns, rows, notes }.
 * Numeric columns hold numbers (or null), text columns hold strings.
 * Returns null when there are no data rows.
 */
function normalizeTable(grid, name) {
  const notes = [];
  let rows = grid.map((row) => (row ?? []).map(cellText)).filter((row) => row.some((cell) => cell !== ''));
  if (!rows.length) return null;

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  rows = rows.map((row) => (row.length < width ? [...row, ...Array(width - row.length).fill('')] : row));

  // Skip title lines above the table: the header is the first reasonably filled row
  const filled = rows.map((row) => row.filter((cell) => cell !== '').length);
  const maxFilled = Math.max(...filled);
  const threshold = maxFilled < 2 ? 1 : Math.max(2, Math.ceil(maxFilled / 2));
  const start = filled.findIndex((count) => count >= threshold);
  if (start > 0) {
    notes.push(`Skipped ${start} line${start === 1 ? '' : 's'} above the table.`);
    rows = rows.slice(start);
  }

  // Drop columns that are empty everywhere
  const keep = [...Array(width).keys()].filter((c) => rows.some((row) => row[c] !== ''));
  rows = rows.map((row) => keep.map((c) => row[c]));

  const hasHeader = rows[0].some((cell) => cell !== '' && parseNumber(cell) === null);
  const headerCells = hasHeader ? rows.shift() : [];
  const labels = uniqueLabels(keep.map((_, i) => headerCells[i] || `Column ${i + 1}`));

  const before = rows.length;
  rows = rows.filter((row) => !TOTAL_ROW_RE.test(row.find((cell) => cell !== '') ?? ''));
  const dropped = before - rows.length;
  if (dropped) {
    notes.push(`Ignored ${dropped} "Total" row${dropped === 1 ? '' : 's'} from the input; totals are recalculated below.`);
  }
  if (!rows.length) return null;

  const columns = labels.map((label, c) => {
    const parsed = rows.map((row) => row[c]).filter((cell) => !isBlankish(cell)).map(parseNumber);
    if (!parsed.length || parsed.includes(null)) return { label, type: 'text' };
    return {
      label,
      type: 'number',
      decimals: Math.min(MAX_DECIMALS, Math.max(...parsed.map((p) => p.decimals))),
      percent: parsed.every((p) => p.percent),
    };
  });

  const data = rows.map((row) =>
    columns.map((column, c) => {
      if (column.type === 'text') return row[c];
      return isBlankish(row[c]) ? null : parseNumber(row[c]).value;
    }),
  );

  return { name, columns, rows: data, notes };
}
