import { useState } from 'react';
import { useLoginReport } from '../lib/angelLogin.js';
import { formatCell, roundTo, signClass } from '../lib/columns.js';
import { BIAS_TONE, biasTally, dailyRows, dayLabel } from '../lib/daily.js';

const TWO_DECIMALS = { type: 'number', decimals: 2 };
const OPEN_KEY = 'daily-analysis-open';

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusText({ status, message, source, daily }) {
  switch (status) {
    case 'live':
      return `Live from ${source === 'angel' ? 'Angel One (fallback)' : 'Upstox'}${daily ? ` · ${timeLabel(daily.updatedAt)}` : ''}`;
    case 'closed':
      return `Market closed${daily ? ` · session of ${dayLabel(daily.date)}` : ''}`;
    case 'connecting':
      return `Connecting to ${source === 'angel' ? 'Angel One' : 'Upstox'}…`;
    case 'needs-login':
      return 'Waiting for Angel One login';
    default:
      return message;
  }
}

/** NIFTY 50 on the daily timeframe: where the LTP stands against the previous day, week, EMAs and all-time high. */
export default function DailyAnalysis({ live }) {
  const { daily } = live;
  const [open, setOpen] = useState(readOpen);
  useLoginReport('daily', live);

  function toggle() {
    setOpen((prev) => {
      try {
        localStorage.setItem(OPEN_KEY, String(!prev));
      } catch {
        // Not remembered; it still toggles
      }
      return !prev;
    });
  }

  const change = daily?.prevDay ? daily.ltp - daily.prevDay.close : null;
  const changeSign = change === null ? '' : signClass(roundTo(change, 2));
  const rows = daily ? dailyRows(daily) : [];
  const { counts, verdict } = biasTally(rows);

  return (
    <section className="table-card daily-card" aria-label="NIFTY 50 daily analysis">
      <div className="daily-head">
        <div className="daily-title">
          <strong>NIFTY 50</strong>
          <span className="toolbar-count">Daily analysis</span>
        </div>
        {daily && (
          <div className="daily-price">
            <span className="daily-ltp">{formatCell(daily.ltp, TWO_DECIMALS)}</span>
            {change !== null && (
              <span className={changeSign}>
                {change > 0 ? '+' : ''}
                {formatCell(change, TWO_DECIMALS)} ({change > 0 ? '+' : ''}
                {((change / daily.prevDay.close) * 100).toFixed(2)}%)
              </span>
            )}
          </div>
        )}
        {daily && (
          <div className="daily-bias" title="Rows by bias; the verdict is the side with more rows">
            <span className={`daily-tag is-${BIAS_TONE[verdict]}`}>{verdict}</span>
            <span className="daily-bias-counts">
              <span className="pos">Bullish {counts.Bullish}</span> · <span className="neg">Bearish {counts.Bearish}</span> ·
              Neutral {counts.Neutral}
              {counts.Sideways > 0 && ` · Sideways ${counts.Sideways}`}
            </span>
          </div>
        )}
        <div className="delta-status" role="status">
          <span className={`status-dot is-${live.status}`} aria-hidden="true" />
          <span>{statusText(live)}</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-small daily-toggle"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && daily && (
        <div className="table-scroll">
          <table className="daily-table">
            <thead>
              <tr>
                <th scope="col">Condition</th>
                <th scope="col" className="daily-status">Status</th>
                <th scope="col" className="daily-status">Bias</th>
                <th scope="col" className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" title={row.title}>{row.label}</th>
                  <td className="daily-status">
                    <span className={`daily-tag is-${row.tone}`}>{row.status}</span>
                  </td>
                  <td className="daily-status">
                    <span className={`daily-tag is-${row.bias ? BIAS_TONE[row.bias] : 'muted'}`}>{row.bias ?? '—'}</span>
                  </td>
                  <td className="num">{row.value === null ? '' : formatCell(row.value, TWO_DECIMALS)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
