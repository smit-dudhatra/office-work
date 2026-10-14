// Column heuristics, number formatting and CSV export.

const PNL_RE = /\bp\s*[&/]?\s*l\b|pnl|m2m|mtm|profit|loss|gain|unreali[sz]ed|reali[sz]ed/i;
const CHANGE_RE = /\bchg\b|change/i;
// Per-unit values (prices, greeks, % change) are meaningless when added up
const NOT_SUMMABLE_RE = /\b(?:ltp|price|avg|average|rate|close|open|high|low|strike|lot\s*size|iv|delta|gamma|theta|vega|chg)\b|%/i;

/** Columns whose values get green / red by sign. */
export function isSignColored(column) {
  return column.type === 'number' && (PNL_RE.test(column.label) || CHANGE_RE.test(column.label));
}

/** Columns that get a value in the totals row. */
export function isSummable(column) {
  if (column.type !== 'number' || column.percent) return false;
  if (PNL_RE.test(column.label)) return true;
  return !NOT_SUMMABLE_RE.test(column.label);
}

const formatters = new Map();

function numberFormatter(decimals) {
  if (!formatters.has(decimals)) {
    formatters.set(
      decimals,
      new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    );
  }
  return formatters.get(decimals);
}

/** Round to the column's precision; `|| 0` turns -0 into 0 so it never shows as "-0.00". */
export function roundTo(value, decimals) {
  return Number(value.toFixed(decimals)) || 0;
}

export function formatCell(value, column) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type !== 'number') return value;
  return numberFormatter(column.decimals).format(roundTo(value, column.decimals)) + (column.percent ? '%' : '');
}

export function signClass(value) {
  if (typeof value !== 'number' || value === 0) return '';
  return value > 0 ? 'pos' : 'neg';
}

function csvValue(value, column) {
  if (value === null || value === undefined) return '';
  if (column.type === 'number') return column.percent ? `${value}%` : String(value);
  // Stop Excel from treating text like "=cmd" as a formula when the CSV is opened
  return /^[=+\-@]/.test(value) && value.length > 1 && Number.isNaN(Number(value)) ? `'${value}` : value;
}

function csvEscape(text) {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns, rows) {
  const lines = [columns.map((column) => csvEscape(column.label)).join(',')];
  for (const row of rows) {
    lines.push(row.map((value, i) => csvEscape(csvValue(value, columns[i]))).join(','));
  }
  // BOM so Excel opens it as UTF-8 (keeps ₹ and other symbols intact)
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function downloadFile(filename, contents, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
