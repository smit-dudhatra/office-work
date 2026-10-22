import * as XLSX from 'xlsx';

// Cell background colours ('#RRGGBB', or null for no fill) from pasted HTML and from spreadsheet files.
// White counts as no fill: web pages and many exports paint every cell white.

const NAMED_COLORS = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', lime: '00FF00', blue: '0000FF', yellow: 'FFFF00',
  aqua: '00FFFF', cyan: '00FFFF', fuchsia: 'FF00FF', magenta: 'FF00FF', silver: 'C0C0C0', gray: '808080',
  grey: '808080', maroon: '800000', olive: '808000', green: '008000', purple: '800080', teal: '008080',
  navy: '000080', orange: 'FFA500',
};

// Excel's default palette for <fgColor indexed="n"> (n = 0..63)
const INDEXED_COLORS = (
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333'
).split(' ');

// ------------------------------------------------------------------ colours

/** '#RRGGBB', or null for transparent / white. Translucent colours are blended onto white, as they were shown. */
function toFill(r, g, b, alpha = 1) {
  if (!(alpha > 0)) return null;
  const hex = [r, g, b]
    .map((v) => Math.round(alpha * Math.min(255, Math.max(0, v)) + (1 - alpha) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return hex === 'FFFFFF' ? null : `#${hex}`;
}

/** 'FC0', '#FFC000' or 'FFC000CC' (alpha last) → fill. */
function fromHex(text) {
  let hex = text.replace(/^#/, '');
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((ch) => ch + ch).join('');
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) return null;
  const [r, g, b, a = 255] = hex.match(/../g).map((pair) => parseInt(pair, 16));
  return toFill(r, g, b, a / 255);
}

/** The colour in a CSS background value: "#FFC7CE", "yellow", "rgb(255 199 206 / 50%) none repeat"… */
function cssColor(value) {
  const clean = value.replace(/url\([^)]*\)/gi, ' ');
  for (const [token] of clean.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z]+/gi)) {
    if (token.startsWith('#')) return fromHex(token);
    if (token.includes('(')) {
      const parts = token.slice(token.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean);
      const [r, g, b] = parts.slice(0, 3).map((p) => parseFloat(p) * (p.endsWith('%') ? 2.55 : 1));
      const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
      return [r, g, b, alpha].every(Number.isFinite) ? toFill(r, g, b, alpha) : null;
    }
    const name = token.toLowerCase();
    if (name === 'transparent') return null;
    if (NAMED_COLORS[name]) return fromHex(NAMED_COLORS[name]);
  }
  return null;
}

/** Excel's tint: move the HSL lightness towards white (tint > 0) or black (tint < 0). */
function applyTint(hex, tint) {
  if (!tint) return hex;
  const [r, g, b] = hex.match(/../g).map((pair) => parseInt(pair, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (max !== min) {
    const d = max - min;
    saturation = lightness > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue /= 6;
  }
  lightness = tint < 0 ? lightness * (1 + tint) : 1 - (1 - lightness) * (1 - tint);

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (t) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue + 1 / 3, hue, hue - 1 / 3]
    .map((t) => Math.round(channel(t) * 255).toString(16).padStart(2, '0'))
    .join('');
}

// ------------------------------------------------------------ spreadsheet files

/** SheetJS drops <fgColor indexed="n">, so read those from styles.xml (needs bookFiles). Keyed by SheetJS's fill object. */
function indexedFills(workbook) {
  const found = new Map();
  const fills = workbook.Styles?.Fills;
  const content = workbook.files?.['xl/styles.xml']?.content;
  if (!fills || !content) return found;

  const xml = Buffer.from(content).toString('utf8');
  const fillsXml = xml.match(/<(?:\w+:)?fills\b[\s\S]*?<\/(?:\w+:)?fills>/)?.[0] ?? '';
  const indexes = [...fillsXml.matchAll(/<(?:\w+:)?fill\b(?:[^>]*\/>|[\s\S]*?<\/(?:\w+:)?fill>)/g)].map(
    ([fill]) => fill.match(/<(?:\w+:)?fgColor\b[^>]*\bindexed="(\d+)"/)?.[1],
  );
  // SheetJS counts gradient fills differently; if the lists disagree, don't guess
  if (indexes.length !== fills.length) return found;
  indexes.forEach((index, i) => {
    if (index !== undefined && INDEXED_COLORS[index]) found.set(fills[i], INDEXED_COLORS[index]);
  });
  return found;
}

/** Colour lookups for a workbook read with { cellStyles: true, bookFiles: true }. */
export function workbookPalette(workbook) {
  return {
    theme: (workbook.Themes?.themeElements?.clrScheme ?? []).map((color) => color?.rgb),
    indexed: indexedFills(workbook),
  };
}

function cellFill(cell, palette) {
  const style = cell?.s;
  if (style?.patternType !== 'solid' || !style.fgColor) return null;
  const { rgb, theme, tint } = style.fgColor;
  if (rgb) return fromHex(rgb);
  // SheetJS resolves theme colours except theme 0 ("White, Background 1", often darkened into a grey)
  if (theme !== undefined) return palette.theme[theme] ? fromHex(applyTint(palette.theme[theme], tint)) : null;
  const indexed = palette.indexed.get(style);
  return indexed ? fromHex(indexed) : null;
}

/**
 * Fills for the grid read from a sheet: one row per entry of `rowNumbers` (0-based sheet rows),
 * one column per column of `range`. Null when no cell has a fill.
 */
export function sheetFills(sheet, rowNumbers, range, palette) {
  const dense = sheet['!data'];
  let found = false;
  const fills = rowNumbers.map((r) => {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const fill = cellFill(dense ? dense[r]?.[c] : sheet[XLSX.utils.encode_cell({ r, c })], palette);
      if (fill) found = true;
      row.push(fill);
    }
    return row;
  });
  return found ? fills : null;
}

// -------------------------------------------------------------- pasted HTML

const TAG_RE = /<(\/?)([a-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/gi;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const LINE_BREAK_TAGS = new Set(['br', 'p', 'div', 'li']);
const MAX_SPAN = 1000;
// Share of non-empty cells whose text must agree before the HTML's colours are trusted to line up
const MATCH_RATIO = 0.9;
const EMPTY_CELL = { text: '', fill: null };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity;
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}

function parseAttributes(source) {
  const attrs = {};
  for (const [, name, ...values] of source.matchAll(ATTR_RE)) {
    attrs[name.toLowerCase()] = decodeEntities(values.find((v) => v !== undefined) ?? '');
  }
  return attrs;
}

/** Colour from `background` / `background-color` declarations; undefined when there are none. */
function backgroundOf(declarations = '') {
  let fill;
  for (const declaration of declarations.split(';')) {
    const colon = declaration.indexOf(':');
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (property === 'background' || property === 'background-color') fill = cssColor(declaration.slice(colon + 1));
  }
  return fill;
}

/** Fills from simple class rules in <style> blocks, which is how Excel writes its cell formats (.xl65 {…}). */
function classFills(html) {
  const fills = new Map();
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const rules = css.replace(/<!--|-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const fill = backgroundOf(body);
      if (fill === undefined) continue;
      for (const selector of selectors.split(',')) {
        const name = selector.trim().match(/^(?:t[dhr])?\.([\w-]+)$/i)?.[1];
        if (name) fills.set(name, fill);
      }
    }
  }
  return fills;
}

function elementFill(attrs, classes) {
  const inline = backgroundOf(attrs.style);
  if (inline !== undefined) return inline;
  for (const name of (attrs.class ?? '').split(/\s+/).reverse()) {
    if (classes.get(name)) return classes.get(name);
  }
  return attrs.bgcolor ? cssColor(attrs.bgcolor) : null;
}

function isHidden(attrs) {
  return /display\s*:\s*none/i.test(attrs.style ?? '');
}

function span(value) {
  const n = parseInt(value, 10);
  return n > 1 ? Math.min(n, MAX_SPAN) : 1;
}

/** Every <tr> in the HTML, in order, as { hidden, cells: [{ text, fill, colspan, rowspan, hidden }] }. */
function readHtmlRows(html) {
  const classes = classFills(html);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '');

  const rows = [];
  let row = null;
  let cell = null;
  let nested = 0; // depth of tables inside a cell; their text belongs to that cell
  let last = 0;
  for (const match of body.matchAll(TAG_RE)) {
    if (cell) cell.text += decodeEntities(body.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();

    if (nested) {
      if (name === 'table') nested += closing ? -1 : 1;
      cell.text += ' ';
    } else if (name === 'table') {
      if (!closing && cell) nested = 1;
      else row = cell = null;
    } else if (name === 'tr') {
      cell = null;
      row = closing ? null : { attrs: parseAttributes(match[3]), cells: [] };
      if (row) rows.push(row);
    } else if (name === 'td' || name === 'th') {
      if (closing) {
        cell = null;
        continue;
      }
      if (!row) rows.push((row = { attrs: {}, cells: [] }));
      cell = { attrs: parseAttributes(match[3]), text: '' };
      row.cells.push(cell);
    } else if (cell && LINE_BREAK_TAGS.has(name)) {
      cell.text += '\n';
    }
  }

  return rows.map(({ attrs, cells }) => {
    const rowFill = elementFill(attrs, classes);
    return {
      hidden: isHidden(attrs),
      cells: cells.map((c) => ({
        text: c.text,
        fill: elementFill(c.attrs, classes) ?? rowFill,
        colspan: span(c.attrs.colspan),
        rowspan: span(c.attrs.rowspan),
        hidden: isHidden(c.attrs),
      })),
    };
  });
}

/**
 * Put the HTML cells on a grid. Excel's text repeats merged cells as blanks, so `expand` spreads
 * colspan / rowspan over the grid; a browser's text has one entry per cell, so it doesn't.
 */
function layout(rows, { expand, skipHidden }) {
  const kept = skipHidden ? rows.filter((row) => !row.hidden) : rows;
  const grid = kept.map(() => []);
  kept.forEach((row, r) => {
    let c = 0;
    for (const cell of row.cells) {
      if (skipHidden && cell.hidden) continue;
      if (!expand) {
        grid[r].push(cell);
        continue;
      }
      while (grid[r][c]) c++;
      for (let dr = 0; dr < cell.rowspan && r + dr < grid.length; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          grid[r + dr][c + dc] = dr || dc ? { text: '', fill: cell.fill } : cell;
        }
      }
      c += cell.colspan;
    }
  });
  return grid.map((row) => Array.from(row, (cell) => cell ?? EMPTY_CELL));
}

function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function nonEmptyRows(rows, textOf) {
  return rows.flatMap((row, r) => (row.some((cell) => squash(textOf(cell)) !== '') ? [r] : []));
}

/** Fills shaped like `grid`, if the HTML cells hold the same text as the grid; otherwise null. */
function align(grid, cells) {
  const gridRows = nonEmptyRows(grid, (text) => text);
  const cellRows = nonEmptyRows(cells, (cell) => cell.text);
  if (!gridRows.length || gridRows.length !== cellRows.length) return null;

  let compared = 0;
  let same = 0;
  gridRows.forEach((r, k) => {
    const texts = grid[r];
    const html = cells[cellRows[k]];
    for (let c = 0; c < Math.max(texts.length, html.length); c++) {
      const a = squash(texts[c]);
      const b = squash(html[c]?.text);
      if (!a && !b) continue;
      compared += 1;
      if (a === b) same += 1;
    }
  });
  if (!compared || same < compared * MATCH_RATIO) return null;

  const fills = grid.map(() => []);
  gridRows.forEach((r, k) => {
    fills[r] = cells[cellRows[k]].map((cell) => cell.fill);
  });
  return fills;
}

/**
 * Cell fills from the clipboard's text/html, lined up with `grid` (the cells read from the pasted text).
 * `fills` is null when the HTML has no colours; `unmatched` means it has some, but its cells don't line
 * up with the text, so they can't be placed.
 */
export function htmlFills(html, grid) {
  const rows = readHtmlRows(html);
  if (!rows.some((row) => row.cells.some((cell) => cell.fill))) return { fills: null, unmatched: false };

  for (const expand of [true, false]) {
    for (const skipHidden of [false, true]) {
      const fills = align(grid, layout(rows, { expand, skipHidden }));
      if (fills) return { fills, unmatched: false };
    }
  }
  return { fills: null, unmatched: true };
}
