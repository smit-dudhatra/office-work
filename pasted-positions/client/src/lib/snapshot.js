// A JPEG picture of tables, drawn on a canvas: plain grid, light theme, each cell's own fill.

import { fillStyle, ON_LIGHT } from './fills.js';

const FONT_SIZE = 13.5;
const LINE_HEIGHT = 18;
const PAD_X = 12;
const PAD_Y = 7;
const MARGIN = 8;
const GAP = 16; // between tables, across and down
const HEADER_BG = '#f0f2f5';
const BODY_BG = '#ffffff';
const GRID = '#c5cbd4';
const SCALE = 2; // twice the screen's pixels, so the text stays sharp when zoomed
// Browsers refuse to draw canvases much bigger than this
const MAX_SIDE = 16_000;
const MAX_AREA = 120_000_000;
const QUALITY = 0.95;

function linesOf(text) {
  return text.split(/\r\n|\n|\r/);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** Where the cell borders go: `start`, then the running total of the sizes. */
function edges(sizes, start) {
  const at = [start];
  for (const size of sizes) at.push(at[at.length - 1] + size);
  return at;
}

/** A table's rows of cells, ready to draw: text, alignment, weight and colours. */
function prepare({ header = null, rows, footer = null }) {
  const grid = [...(header ? [header] : []), ...rows, ...(footer ? [footer] : [])];
  return grid.map((row, r) => {
    const isHeader = header !== null && r === 0;
    const isFooter = footer !== null && r === grid.length - 1;
    return row.map((cell) => ({
      text: String(cell.text ?? ''),
      numeric: Boolean(cell.numeric),
      // The header and the Total row are bold
      bold: Boolean(cell.bold) || isHeader || isFooter,
      ...(cell.fill
        ? fillStyle(cell.fill, cell.sign ?? '')
        : { backgroundColor: isHeader ? HEADER_BG : BODY_BG, color: ON_LIGHT[cell.sign || 'text'] }),
    }));
  });
}

function drawTable(ctx, { grid, widths, heights, width, height }, left, top, fontOf) {
  let y = top;
  grid.forEach((row, r) => {
    let x = left;
    row.forEach((cell, c) => {
      ctx.fillStyle = cell.backgroundColor;
      ctx.fillRect(x, y, widths[c], heights[r]);
      ctx.font = fontOf(cell.bold);
      ctx.fillStyle = cell.color;
      ctx.textAlign = cell.numeric ? 'right' : 'left';
      const textX = cell.numeric ? x + widths[c] - PAD_X : x + PAD_X;
      linesOf(cell.text).forEach((line, k) => ctx.fillText(line, textX, y + PAD_Y + LINE_HEIGHT * (k + 0.5)));
      x += widths[c];
    });
    y += heights[r];
  });

  // Gridlines over the fills, like Excel's
  ctx.beginPath();
  for (const lineY of edges(heights, top)) {
    ctx.moveTo(left, lineY);
    ctx.lineTo(left + width, lineY);
  }
  for (const lineX of edges(widths, left)) {
    ctx.moveTo(lineX, top);
    ctx.lineTo(lineX, top + height);
  }
  ctx.stroke();
}

/**
 * The tables as a JPEG blob. `layout` is a list of lines, top to bottom, each a list of tables side by side
 * (left-aligned, tops lined up). Each table is { header?, rows, footer? }: `header` is a cell per column, `rows`
 * a row of cells per table row, and `footer` a Total row. A cell is
 * { text, numeric?, fill? ('#RRGGBB'), sign? ('pos' / 'neg'), bold? }. Numeric cells are right-aligned, the rest
 * left-aligned; the header and the Total row are bold.
 */
export async function tableSnapshot(layout) {
  await document.fonts?.ready;
  const family = getComputedStyle(document.body).fontFamily;
  const fontOf = (bold) => `${bold ? '600 ' : ''}${FONT_SIZE}px ${family}`;
  const measure = document.createElement('canvas').getContext('2d');
  const widthOf = (cell) => {
    measure.font = fontOf(cell.bold);
    return Math.max(...linesOf(cell.text).map((line) => measure.measureText(line).width));
  };

  const measureTable = (table) => {
    const grid = prepare(table);
    const widths = grid[0].map((_, c) => Math.ceil(Math.max(...grid.map((row) => widthOf(row[c])))) + 2 * PAD_X);
    const heights = grid.map((row) => Math.max(...row.map((cell) => linesOf(cell.text).length)) * LINE_HEIGHT + 2 * PAD_Y);
    return { grid, widths, heights, width: sum(widths), height: sum(heights) };
  };
  const lines = layout.map((line) => {
    const tables = line.map(measureTable);
    return {
      tables,
      width: sum(tables.map((table) => table.width)) + GAP * (tables.length - 1),
      height: Math.max(...tables.map((table) => table.height)),
    };
  });
  const width = Math.max(...lines.map((line) => line.width)) + 2 * MARGIN;
  const height = sum(lines.map((line) => line.height)) + GAP * (lines.length - 1) + 2 * MARGIN;
  // A long table is drawn smaller rather than not at all
  const scale = Math.min(SCALE, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = BODY_BG; // JPEG has no transparency
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;

  let top = MARGIN;
  for (const line of lines) {
    let left = MARGIN;
    for (const table of line.tables) {
      drawTable(ctx, table, left, top, fontOf);
      left += table.width + GAP;
    }
    top += line.height + GAP;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser could not create the image.'))),
      'image/jpeg',
      QUALITY,
    );
  });
}
