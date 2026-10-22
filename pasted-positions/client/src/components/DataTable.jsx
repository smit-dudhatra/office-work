import { useMemo, useState } from 'react';
import { downloadFile, formatCell, isSignColored, isSummable, roundTo, signClass, toCsv } from '../lib/columns.js';
import { fillStyle } from '../lib/fills.js';
import { readPositions } from '../lib/positions.js';
import { useLiveGreeks } from '../lib/useLiveGreeks.js';
import DeltaSummary from './DeltaSummary.jsx';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Columns added to option positions: the side, then the live delta of the option and of the row
const SIDE_COLUMN = { label: 'Side', type: 'text' };
const DELTA_COLUMNS = [
  { key: 'delta', label: 'Delta', type: 'number', decimals: 4 },
  { key: 'qty', label: 'Delta (qty)', type: 'number', decimals: 2 },
  { key: 'lots', label: 'Delta (lots)', type: 'number', decimals: 2 },
];

function isEmpty(value) {
  return value === null || value === '';
}

function sumOf(entries, key) {
  const values = entries.map((entry) => entry[key]).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function LiveCells({ entry, onFlip }) {
  if (!entry) {
    return (
      <>
        <td />
        {DELTA_COLUMNS.map((column) => <td key={column.key} className={column.key === 'lots' ? 'live-end' : undefined} />)}
      </>
    );
  }
  // Waiting for the first greeks, or Angel One doesn't list this option
  const missing = entry.loaded ? '—' : '…';
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
      {DELTA_COLUMNS.map((column) => (
        <td
          key={column.key}
          className={column.key === 'lots' ? 'num live-end' : 'num'}
          title={column.key === 'delta' && entry.iv ? `IV ${entry.iv.toFixed(2)}%` : undefined}
        >
          {entry[column.key] !== null ? formatCell(entry[column.key], column) : entry.qty === null ? missing : ''}
        </td>
      ))}
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

export default function DataTable({ sheet, title, exportName, onClear }) {
  const { columns, rows, notes, fills } = sheet;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null); // { index, dir: 'asc' | 'desc' }

  const colored = useMemo(() => columns.map(isSignColored), [columns]);
  const summable = useMemo(() => columns.map(isSummable), [columns]);

  // Option positions with live deltas; null when the sheet isn't a list of options
  const positions = useMemo(() => readPositions(sheet), [sheet]);
  const expiries = useMemo(
    () => [...new Set((positions ?? []).filter(Boolean).map((position) => position.expiry))].sort(),
    [positions],
  );
  const live = useLiveGreeks(expiries);
  const [flipped, setFlipped] = useState(() => new Set()); // row numbers whose side was changed by hand

  const deltas = useMemo(
    () =>
      positions?.map((position, i) => {
        if (!position) return null;
        const isFlipped = flipped.has(i + 1);
        const buy = position.buy !== isFlipped;
        const chain = live.greeks[position.expiry];
        const quote = chain?.strikes[`${position.strike}${position.type}`];
        const qty = quote ? (buy ? 1 : -1) * quote.delta * position.quantity : null;
        return {
          buy,
          flipped: isFlipped,
          loaded: Boolean(chain),
          delta: quote?.delta ?? null,
          iv: quote?.iv ?? null,
          qty,
          lots: qty !== null && position.lotSize ? qty / position.lotSize : null,
        };
      }) ?? null,
    [positions, flipped, live.greeks],
  );

  // Net delta of every position, whatever the filter
  const net = useMemo(() => {
    if (!deltas) return null;
    const entries = deltas.filter(Boolean);
    return {
      qty: sumOf(entries, 'qty'),
      lots: sumOf(entries, 'lots'),
      missing: entries.filter((entry) => entry.loaded && entry.qty === null).length,
      buys: entries.filter((entry) => entry.buy).length,
      sells: entries.filter((entry) => !entry.buy).length,
    };
  }, [deltas]);
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
        const x = a.row[index];
        const y = b.row[index];
        // Blanks always go last, whatever the direction
        if (isEmpty(x) || isEmpty(y)) return isEmpty(x) === isEmpty(y) ? 0 : isEmpty(x) ? 1 : -1;
        return factor * (numeric ? x - y : collator.compare(x, y));
      });
    }
    return list;
  }, [rows, columns, query, sort, searchText]);

  const totals = useMemo(
    () =>
      columns.map((column, i) =>
        summable[i] ? visible.reduce((sum, { row }) => sum + (row[i] ?? 0), 0) : null,
      ),
    [columns, summable, visible],
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
    // Same order as the table: side and deltas first
    const csvRows = visible.map(({ row, n }) => {
      const entry = deltas[n - 1];
      return [entry ? (entry.buy ? 'BUY' : 'SELL') : '', ...DELTA_COLUMNS.map((c) => entry?.[c.key] ?? null), ...row];
    });
    downloadFile(`${exportName}.csv`, toCsv([SIDE_COLUMN, ...DELTA_COLUMNS, ...columns], csvRows));
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
          <button type="button" className="btn btn-ghost" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      {net && <DeltaSummary net={net} live={live} updatedAt={updatedAt} />}

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
                  {DELTA_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={column.key === 'lots' ? 'num col-live live-end' : 'num col-live'}
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
                {deltas && <LiveCells entry={deltas[n - 1]} onFlip={() => flipSide(n)} />}
                {row.map((value, i) => {
                  const numeric = columns[i].type === 'number';
                  const sign = numeric && colored[i] ? signClass(value) : '';
                  const className = numeric ? `num ${sign}` : 'text';
                  const fill = fills?.[n - 1][i];
                  return (
                    <td
                      key={columns[i].label}
                      className={className.trim()}
                      style={fill ? fillStyle(fill, sign) : undefined}
                    >
                      {formatCell(value, columns[i])}
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
                    {DELTA_COLUMNS.map((column) => {
                      // A row's option delta doesn't add up; its quantity and lots do
                      const total = column.key === 'delta' ? null : sumOf(visibleDeltas, column.key);
                      return (
                        <td key={column.key} className={column.key === 'lots' ? 'num live-end' : 'num'}>
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
