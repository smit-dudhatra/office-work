import { useMemo, useState } from 'react';
import { downloadFile, formatCell, isSignColored, isSummable, roundTo, signClass, toCsv } from '../lib/columns.js';
import { fillStyle } from '../lib/fills.js';
import { expiryOrder, expiryValue, LOTS_COLUMN_RE, PNL_COLUMN_RE, pnlAt, readPositions } from '../lib/positions.js';
import { useLoginReport } from '../lib/angelLogin.js';
import { formatLots, lotsRows } from '../lib/lots.js';
import { niftyRows } from '../lib/niftyNow.js';
import { tableSnapshot } from '../lib/snapshot.js';
import { useLiveGreeks } from '../lib/useLiveGreeks.js';
import { useLotSizes } from '../lib/useLotSizes.js';
import { useMargin } from '../lib/useMargin.js';
import DeltaSummary from './DeltaSummary.jsx';
import LotsTable from './LotsTable.jsx';
import MarginDetails from './MarginDetails.jsx';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Columns added to option positions: the side, the live delta of the option and of the row, and the P&L
const SIDE_COLUMN = { label: 'Side', type: 'text' };
const DELTA_COLUMNS = [
  { key: 'delta', label: 'Delta', type: 'number', decimals: 4 },
  { key: 'qty', label: 'Delta (qty)', type: 'number', decimals: 2 },
  { key: 'lots', label: 'Delta (lots)', type: 'number', decimals: 2 },
];
const PNL_COLUMN = { key: 'pnl', label: 'Live P&L', type: 'number', decimals: 2 };

function isEmpty(value) {
  return value === null || value === '';
}

/** The sheet's lot size for a position, else the one Angel One lists for its expiry. */
function lotSizeOf(position, lotSizes) {
  return position.lotSize || lotSizes?.[position.expiry] || null;
}

function sumOf(entries, key) {
  const values = entries.map((entry) => entry[key]).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

/** A cell value the live feed has replaced (LTP, P&L) is shown to at least the paise. */
function liveFormat(column) {
  return { ...column, decimals: Math.max(column.decimals, 2) };
}

/** What a cell shows: the live value where the feed has replaced the pasted one. */
function valueAt(rows, deltas, n, i) {
  return deltas?.[n - 1]?.overrides[i] ?? rows[n - 1][i];
}

/** Columns the JPEG's Total row adds up: No. Lot and P&L. */
function isSnapshotTotal(column) {
  const label = column.label.trim();
  return column.type === 'number' && (LOTS_COLUMN_RE.test(label) || PNL_COLUMN_RE.test(label));
}

/** A pasted cell as the table shows it: the live value where the feed has replaced it (LTP, P&L), and its sign. */
function pastedCell(entry, row, i, column, colored) {
  const isLive = entry?.overrides[i] !== undefined;
  const value = isLive ? entry.overrides[i] : row[i];
  const numeric = column.type === 'number';
  return {
    numeric,
    isLtp: isLive && entry.ltpColumn === i,
    sign: numeric && colored ? signClass(isLive ? roundTo(value, 2) : value) : '',
    text: formatCell(value, isLive ? liveFormat(column) : column),
  };
}

function LiveCells({ entry, columns, onFlip }) {
  const lastKey = columns[columns.length - 1].key;
  if (!entry) {
    return (
      <>
        <td />
        {columns.map((column) => <td key={column.key} className={column.key === lastKey ? 'live-end' : undefined} />)}
      </>
    );
  }
  // Waiting for the first greeks / price, or Angel One doesn't list this option
  const missing = (key) => ((key === 'pnl' ? entry.priced : entry.loaded) ? '—' : '…');
  return (
    <>
      <td>
        <button
          type="button"
          className={`side-tag ${entry.buy ? 'is-buy' : 'is-sell'}${entry.flipped ? ' is-flipped' : ''}`}
          onClick={onFlip}
          title={
            entry.flipped
              ? 'Changed by you. Click to change back.'
              : `From the row colour. Click to make it ${entry.buy ? 'SELL' : 'BUY'}.`
          }
        >
          {entry.buy ? 'BUY' : 'SELL'}
        </button>
      </td>
      {columns.map((column) => {
        const value = entry[column.key];
        const sign = column.key === 'pnl' && value !== null ? signClass(roundTo(value, column.decimals)) : '';
        const unavailable = column.key === 'pnl' ? value === null : entry.qty === null;
        return (
          <td
            key={column.key}
            className={['num', sign, column.key === lastKey && 'live-end'].filter(Boolean).join(' ')}
            title={column.key === 'delta' && entry.iv ? `IV ${entry.iv.toFixed(2)}%` : undefined}
          >
            {value !== null ? formatCell(value, column) : unavailable ? missing(column.key) : ''}
          </td>
        );
      })}
    </>
  );
}

function SortIcon({ dir }) {
  return (
    <svg className={`sort-icon${dir ? ' is-active' : ''}`} viewBox="0 0 10 14" width="8" height="12" aria-hidden="true">
      <path d="M5 1 9 5H1z" opacity={dir === 'desc' ? 0.25 : 1} />
      <path d="M5 13 1 9h8z" opacity={dir === 'asc' ? 0.25 : 1} />
    </svg>
  );
}

/** `nifty` is the latest NIFTY 50 daily update (null until there is one). */
export default function DataTable({ sheet, title, exportName, onClear, nifty = null }) {
  const { columns, rows, notes, fills, headerFills } = sheet;
  const niftyLtp = nifty?.ltp ?? null;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null); // { index, dir: 'asc' | 'desc' }

  const colored = useMemo(() => columns.map(isSignColored), [columns]);
  const summable = useMemo(() => columns.map(isSummable), [columns]);

  // Option positions with live deltas and P&L; null when the sheet isn't a list of options
  const read = useMemo(() => readPositions(sheet), [sheet]);
  const positions = read?.positions ?? null;
  const prices = read?.prices ?? null; // column indexes of buy price, sell price and P&L; null without both prices
  const expiries = useMemo(
    () => [...new Set((positions ?? []).filter(Boolean).map((position) => position.expiry))].sort(),
    [positions],
  );
  // Strikes to price: only when there are price columns to put the LTP in
  const quotes = useMemo(
    () =>
      prices
        ? [...new Set(positions.filter(Boolean).map((p) => `${p.expiry}:${p.strike}${p.type}`))].sort()
        : [],
    [positions, prices],
  );
  const live = useLiveGreeks(expiries, quotes);
  useLoginReport('positions', live);
  const lotSizes = useLotSizes(expiries);
  const liveColumns = useMemo(() => (prices ? [...DELTA_COLUMNS, PNL_COLUMN] : DELTA_COLUMNS), [prices]);
  const [flipped, setFlipped] = useState(() => new Set()); // row numbers whose side was changed by hand

  // Margin of every position with the side it shows (flips included), whatever the filter
  const marginPositions = useMemo(
    () =>
      (positions ?? []).flatMap((position, i) =>
        position
          ? [{
              expiry: position.expiry,
              strike: position.strike,
              type: position.type,
              quantity: position.quantity,
              buy: position.buy !== flipped.has(i + 1),
            }]
          : [],
      ),
    [positions, flipped],
  );
  const margin = useMargin(marginPositions);

  // Lots by side (flips included) and option type, for every position whatever the filter
  const lotCounts = useMemo(() => {
    if (!positions) return null;
    const counts = { sell: { CE: 0, PE: 0 }, buy: { CE: 0, PE: 0 }, missing: 0, pending: false };
    positions.forEach((position, i) => {
      if (!position) return;
      const lotSize = lotSizeOf(position, lotSizes);
      if (!lotSize) {
        if (lotSizes === null) counts.pending = true;
        else counts.missing += 1;
        return;
      }
      const buy = position.buy !== flipped.has(i + 1);
      counts[buy ? 'buy' : 'sell'][position.type] += position.quantity / lotSize;
    });
    return counts;
  }, [positions, flipped, lotSizes]);

  const deltas = useMemo(
    () =>
      positions?.map((position, i) => {
        if (!position) return null;
        const isFlipped = flipped.has(i + 1);
        const buy = position.buy !== isFlipped;
        const chain = live.greeks[position.expiry];
        const strike = `${position.strike}${position.type}`;
        const quote = chain?.strikes[strike];
        const qty = quote ? (buy ? 1 : -1) * quote.delta * position.quantity : null;
        // Prices tick with the live feed; delta follows the greeks poll
        const known = live.ltps[position.expiry];
        const ltp = prices ? known?.[strike] ?? null : null;
        const pnl = pnlAt(position, buy, ltp);
        const lotSize = lotSizeOf(position, lotSizes);
        // Shown in place of the pasted cells. The LTP goes in the price column opposite to the entry: a SELL's
        // entry is its sell price, so its LTP goes in the buy price column, and the other way round.
        const ltpColumn = ltp !== null ? (buy ? prices.sell : prices.buy) : null;
        const overrides = {};
        if (ltpColumn !== null) overrides[ltpColumn] = ltp;
        if (pnl !== null && prices.pnl !== null) overrides[prices.pnl] = pnl;
        return {
          buy,
          flipped: isFlipped,
          loaded: Boolean(chain),
          priced: Boolean(known && strike in known),
          delta: quote?.delta ?? null,
          iv: quote?.iv ?? null,
          qty,
          lots: qty !== null && lotSize ? qty / lotSize : null,
          ltp,
          ltpColumn,
          pnl,
          overrides,
        };
      }) ?? null,
    [positions, prices, flipped, live.greeks, live.ltps, lotSizes],
  );

  // The expiry that settles in the expiry P&L; later ones would still be trading
  const nearestExpiry = useMemo(
    () => [...expiries].sort((a, b) => expiryOrder(a) - expiryOrder(b))[0] ?? null,
    [expiries],
  );

  // P&L if NIFTY expired at its LTP now: the nearest expiry's options at their expiry value, later ones at their
  // live LTP. { pnl, missing }: rows with no entry price (or, for a later expiry, no live price) are left out.
  const expiry = useMemo(() => {
    if (!deltas || !prices || niftyLtp === null) return { pnl: null, missing: 0 };
    let pnl = null;
    let missing = 0;
    deltas.forEach((entry, i) => {
      if (!entry) return;
      const position = positions[i];
      const settles = position.expiry === nearestExpiry;
      const value = settles ? pnlAt(position, entry.buy, expiryValue(position, niftyLtp)) : entry.pnl;
      if (value !== null) pnl = (pnl ?? 0) + value;
      else if (settles || entry.priced) missing += 1;
    });
    return { pnl, missing };
  }, [deltas, prices, positions, nearestExpiry, niftyLtp]);

  // Net delta of every position, whatever the filter
  const net = useMemo(() => {
    if (!deltas) return null;
    const entries = deltas.filter(Boolean);
    return {
      qty: sumOf(entries, 'qty'),
      lots: sumOf(entries, 'lots'),
      pnl: sumOf(entries, 'pnl'),
      expiryPnl: expiry.pnl,
      missingExpiry: expiry.missing,
      spot: niftyLtp,
      nearestExpiry,
      expiries: expiries.length,
      hasPrices: Boolean(prices),
      missing: entries.filter((entry) => entry.loaded && entry.qty === null).length,
      missingPnl: prices ? entries.filter((entry) => entry.priced && entry.pnl === null).length : 0,
      buys: entries.filter((entry) => entry.buy).length,
      sells: entries.filter((entry) => !entry.buy).length,
    };
  }, [deltas, prices, expiry, niftyLtp, nearestExpiry, expiries]);
  // The oldest of the expiries' updates
  const updatedAt = expiries.map((expiry) => live.greeks[expiry]?.fetchedAt).filter(Boolean).sort()[0];

  function flipSide(n) {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  }

  // Search matches the raw value and the formatted one ("1234.5" and "1,234.50")
  const searchText = useMemo(
    () =>
      rows.map((row) =>
        row
          .map((value, i) => (isEmpty(value) ? '' : `${value} ${formatCell(value, columns[i])}`))
          .join(' ')
          .toLowerCase(),
      ),
    [rows, columns],
  );

  const visible = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = rows.map((row, i) => ({ row, n: i + 1 }));
    if (terms.length) list = list.filter(({ n }) => terms.every((term) => searchText[n - 1].includes(term)));

    if (sort) {
      const { index, dir } = sort;
      const factor = dir === 'asc' ? 1 : -1;
      const numeric = columns[index].type === 'number';
      list = [...list].sort((a, b) => {
        const x = valueAt(rows, deltas, a.n, index);
        const y = valueAt(rows, deltas, b.n, index);
        // Blanks always go last, whatever the direction
        if (isEmpty(x) || isEmpty(y)) return isEmpty(x) === isEmpty(y) ? 0 : isEmpty(x) ? 1 : -1;
        return factor * (numeric ? x - y : collator.compare(x, y));
      });
    }
    return list;
  }, [rows, columns, deltas, query, sort, searchText]);

  const totals = useMemo(
    () =>
      columns.map((column, i) =>
        summable[i] ? visible.reduce((sum, { n }) => sum + (valueAt(rows, deltas, n, i) ?? 0), 0) : null,
      ),
    [columns, summable, visible, rows, deltas],
  );
  const visibleDeltas = useMemo(
    () => (deltas ? visible.map(({ n }) => deltas[n - 1]).filter(Boolean) : []),
    [deltas, visible],
  );
  const showTotals = (summable.some(Boolean) || Boolean(deltas)) && visible.length > 0;

  function toggleSort(index) {
    setSort((prev) => {
      if (!prev || prev.index !== index) return { index, dir: 'asc' };
      return prev.dir === 'asc' ? { index, dir: 'desc' } : null;
    });
  }

  function exportCsv() {
    if (!deltas) {
      downloadFile(`${exportName}.csv`, toCsv(columns, visible.map(({ row }) => row)));
      return;
    }
    // Same order and values as the table: side and live columns first, live prices and P&L in place
    const csvRows = visible.map(({ row, n }) => {
      const entry = deltas[n - 1];
      return [
        entry ? (entry.buy ? 'BUY' : 'SELL') : '',
        ...liveColumns.map((c) => entry?.[c.key] ?? null),
        ...row.map((_, i) => valueAt(rows, deltas, n, i)),
      ];
    });
    downloadFile(`${exportName}.csv`, toCsv([SIDE_COLUMN, ...liveColumns, ...columns], csvRows));
  }

  // A picture of the table as pasted: its columns in their order, every row in pasted order (whatever the filter
  // and sort), the cell colours, and the live LTP / P&L in place, then a Total row for No. Lot and P&L only.
  // No side or delta columns. The lots summary and the NIFTY 50 table go below it, side by side.
  async function exportJpeg() {
    const header = columns.map((column, i) => ({
      text: column.label,
      numeric: column.type === 'number',
      fill: headerFills?.[i] ?? null,
    }));
    const body = rows.map((row, r) =>
      row.map((_, i) => {
        const { text, numeric, sign } = pastedCell(deltas?.[r], row, i, columns[i], colored[i]);
        return { text, numeric, sign, fill: fills?.[r][i] ?? null };
      }),
    );
    // Sum of the values as shown (live P&L where there is one, else the pasted value); blank if the column is empty
    const totalled = columns.map(isSnapshotTotal);
    const footer = totalled.some(Boolean)
      ? columns.map((column, i) => {
          if (!totalled[i]) return { text: i === 0 ? 'Total' : '', numeric: false, fill: null };
          const values = rows.map((_, r) => valueAt(rows, deltas, r + 1, i)).filter((value) => !isEmpty(value));
          // Shown to the paise like the live cells it adds up
          const format = rows.some((_, r) => deltas?.[r]?.overrides[i] !== undefined) ? liveFormat(column) : column;
          const total = values.length ? roundTo(values.reduce((sum, value) => sum + value, 0), format.decimals) : null;
          return {
            text: total === null ? '' : formatCell(total, format),
            numeric: true,
            sign: colored[i] ? signClass(total) : '',
            fill: null,
          };
        })
      : null;
    // Below it: the lots summary, as on screen, and NIFTY 50 at the time of the snapshot
    const below = [];
    if (lotCounts) {
      const [sell, buy, total] = lotsRows(lotCounts);
      const line = (row) => [
        { text: row.label, bold: true },
        ...[row.CE, row.PE, row.total].map((value, k) => ({
          text: formatLots(lotCounts, value),
          numeric: true,
          bold: k === 2,
        })),
      ];
      below.push({
        header: ['Lots', 'CE', 'PE', 'Total'].map((text, k) => ({ text, numeric: k > 0 })),
        rows: [line(sell), line(buy)],
        footer: line(total),
      });
    }
    // SELL positions (flips included) with their live LTP, for the first CE / PE
    const sold = (positions ?? []).flatMap((position, i) =>
      position && !deltas[i].buy
        ? [{ expiry: position.expiry, strike: position.strike, type: position.type, ltp: deltas[i].ltp }]
        : [],
    );
    below.push({
      rows: niftyRows(nifty, { sold }).map(([label, value]) => [{ text: label, bold: true }, { text: value }]),
    });
    downloadFile(`${exportName}.jpeg`, await tableSnapshot([[{ header, rows: body, footer }], below]), 'image/jpeg');
  }

  const countLabel =
    visible.length === rows.length
      ? `${rows.length} row${rows.length === 1 ? '' : 's'} · ${columns.length} column${columns.length === 1 ? '' : 's'}`
      : `${visible.length} of ${rows.length} rows`;

  return (
    <div className="table-card">
      <div className="toolbar">
        <div className="toolbar-info">
          <strong className="toolbar-title" title={title}>{title}</strong>
          <span className="toolbar-count">{countLabel}</span>
        </div>
        <div className="toolbar-actions">
          <input
            type="search"
            className="search"
            placeholder="Filter rows…"
            aria-label="Filter rows"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="btn" onClick={exportCsv} disabled={!visible.length}>
            Export CSV
          </button>
          <button
            type="button"
            className="btn"
            onClick={exportJpeg}
            title="Picture of the pasted table with the live LTP filled in"
          >
            Export JPEG
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      {net && <DeltaSummary net={net} live={live} updatedAt={updatedAt} margin={margin} />}
      {net && <MarginDetails margin={margin} />}
      {lotCounts && <LotsTable lots={lotCounts} />}

      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="col-index" scope="col">#</th>
              {/* Live columns come first so they stay in view on wide sheets */}
              {deltas && (
                <>
                  <th scope="col" className="col-live">{SIDE_COLUMN.label}</th>
                  {liveColumns.map((column, k) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={k === liveColumns.length - 1 ? 'num col-live live-end' : 'num col-live'}
                    >
                      {column.label}
                    </th>
                  ))}
                </>
              )}
              {columns.map((column, i) => {
                const dir = sort?.index === i ? sort.dir : null;
                return (
                  <th
                    key={column.label}
                    scope="col"
                    className={column.type === 'number' ? 'num' : undefined}
                    aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className="sort-btn" onClick={() => toggleSort(i)}>
                      <span>{column.label}</span>
                      <SortIcon dir={dir} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, n }) => (
              <tr key={n}>
                <td className="col-index">{n}</td>
                {deltas && <LiveCells entry={deltas[n - 1]} columns={liveColumns} onFlip={() => flipSide(n)} />}
                {row.map((pasted, i) => {
                  const { numeric, sign, isLtp, text } = pastedCell(deltas?.[n - 1], row, i, columns[i], colored[i]);
                  const className = `${numeric ? `num ${sign}` : 'text'}${isLtp ? ' is-live-ltp' : ''}`;
                  const fill = fills?.[n - 1][i];
                  return (
                    <td
                      key={columns[i].label}
                      className={className.trim()}
                      style={fill ? fillStyle(fill, sign) : undefined}
                      title={isLtp ? `Live LTP${isEmpty(pasted) ? '' : ` · pasted ${formatCell(pasted, columns[i])}`}` : undefined}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {showTotals && (
            <tfoot>
              <tr>
                <th className="col-index" scope="row">Total</th>
                {deltas && (
                  <>
                    <td />
                    {liveColumns.map((column, k) => {
                      // A row's option delta doesn't add up; its quantity, lots and P&L do
                      const total = column.key === 'delta' ? null : sumOf(visibleDeltas, column.key);
                      const sign = column.key === 'pnl' && total !== null ? signClass(roundTo(total, column.decimals)) : '';
                      return (
                        <td
                          key={column.key}
                          className={['num', sign, k === liveColumns.length - 1 && 'live-end'].filter(Boolean).join(' ')}
                        >
                          {total === null ? '' : formatCell(total, column)}
                        </td>
                      );
                    })}
                  </>
                )}
                {columns.map((column, i) => {
                  const total = totals[i];
                  if (total === null) return <td key={column.label} />;
                  const rounded = roundTo(total, column.decimals);
                  return (
                    <td key={column.label} className={`num ${colored[i] ? signClass(rounded) : ''}`.trim()}>
                      {formatCell(rounded, column)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
        {visible.length === 0 && <p className="empty">No rows match “{query.trim()}”.</p>}
      </div>
    </div>
  );
}
