import { useMemo, useState } from 'react';
import { downloadFile, formatCell, isSignColored, isSummable, roundTo, signClass, toCsv } from '../lib/columns.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isEmpty(value) {
  return value === null || value === '';
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
  const { columns, rows, notes } = sheet;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null); // { index, dir: 'asc' | 'desc' }

  const colored = useMemo(() => columns.map(isSignColored), [columns]);
  const summable = useMemo(() => columns.map(isSummable), [columns]);

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
  const showTotals = summable.some(Boolean) && visible.length > 0;

  function toggleSort(index) {
    setSort((prev) => {
      if (!prev || prev.index !== index) return { index, dir: 'asc' };
      return prev.dir === 'asc' ? { index, dir: 'desc' } : null;
    });
  }

  function exportCsv() {
    downloadFile(`${exportName}.csv`, toCsv(columns, visible.map(({ row }) => row)));
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
                {row.map((value, i) => {
                  const numeric = columns[i].type === 'number';
                  const className = numeric ? `num ${colored[i] ? signClass(value) : ''}` : 'text';
                  return (
                    <td key={columns[i].label} className={className.trim()}>
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
