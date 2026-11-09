import { useState } from 'react';
import { formatCell } from '../lib/columns.js';

const TWO_DECIMALS = { type: 'number', decimals: 2 };
const OPEN_KEY = 'margin-details-open';

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * The broker's margin as a sum: [{ label, op, value, total }]. The parts it lists (SPAN, exposure, premium of the
 * bought options) add up to the margin without the hedge benefit; anything they leave out shows as "Other", so the
 * sum always holds. Angel One gives no exposure figure, so for it that line is "Exposure & other".
 */
function statement(m) {
  const parts = [
    { label: 'SPAN', value: m.span },
    { label: 'Exposure', value: m.exposure },
    { label: 'Option premium (buys)', value: m.premium },
  ].filter((part) => part.value !== null);
  const rest = m.required - parts.reduce((sum, part) => sum + part.value, 0);
  if (parts.length && Math.abs(rest) >= 0.5) {
    parts.push({ label: m.exposure === null ? 'Exposure & other' : 'Other', value: rest });
  }
  const lines = parts.map((part, i) => ({
    ...part,
    op: i === 0 ? '' : part.value < 0 ? '−' : '+',
    value: i === 0 ? part.value : Math.abs(part.value),
  }));
  lines.push(
    { label: 'Margin without hedge benefit', op: parts.length ? '=' : '', value: m.required, total: parts.length > 0 },
    { label: 'Hedge benefit', op: '−', value: m.benefit },
    { label: 'Final margin', op: '=', value: m.final, total: true, final: true },
  );
  return lines;
}

/**
 * How the broker worked out the margin (NRML), under the header, opened and closed by the user (remembered in
 * this browser). `margin` comes from useMargin; the panel shows its last result, dimmed while the next one loads.
 */
export default function MarginDetails({ margin }) {
  const [open, setOpen] = useState(readOpen);
  const m = margin.margin;
  if (!m?.source) return null;
  const from = m.source === 'angel' ? 'Angel One' : 'Upstox';
  const stale = margin.status !== 'ok';

  function onToggle(event) {
    const next = event.currentTarget.open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, String(next));
    } catch {
      // Not remembered; it still opens and closes
    }
  }

  return (
    <details className="margin-details" open={open} onToggle={onToggle}>
      <summary>
        Margin details
        <span className="margin-details-meta">
          from {from} at {timeLabel(m.at)}
        </span>
      </summary>
      <div className="margin-details-body">
        <table className={`margin-statement${stale ? ' is-stale' : ''}`}>
          <caption className="visually-hidden">Margin worked out by {from}</caption>
          <tbody>
            {statement(m).map((line) => (
              <tr key={line.label} className={[line.total && 'is-total', line.final && 'is-final'].filter(Boolean).join(' ') || undefined}>
                <th scope="row">{line.label}</th>
                <td className="margin-op" aria-hidden="true">{line.op}</td>
                <td>{formatCell(line.value, TWO_DECIMALS)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="margin-facts">
          <li>NRML (carryforward)</li>
          <li>
            {m.legs} option{m.legs === 1 ? '' : 's'} (rows of the same option netted), all in one request, so hedges
            between them count
          </li>
          {m.skipped.map(({ source, reason }) => (
            <li key={source}>
              {source} not used: {reason}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
