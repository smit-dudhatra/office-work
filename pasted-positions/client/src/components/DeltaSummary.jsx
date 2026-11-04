import { formatCell, roundTo, signClass } from '../lib/columns.js';

const TWO_DECIMALS = { type: 'number', decimals: 2 };

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusText({ status, message, source }, updatedAt) {
  const at = updatedAt ? ` · updated ${timeLabel(updatedAt)}` : '';
  const from = source === 'angel' ? 'Angel One (fallback)' : 'Upstox';
  switch (status) {
    case 'live':
      return `Live from ${from}${at}`;
    case 'closed':
      return `Market closed · last greeks from ${from}${at}`;
    case 'connecting':
      return 'Connecting to Angel One…';
    case 'needs-login':
      return 'Waiting for Angel One login';
    default:
      return message;
  }
}

/**
 * Live P&L and net delta of the pasted positions, with the live-data status.
 * `net` is { qty, lots, pnl, hasPrices, missing, missingPnl, buys, sells } over all rows; qty / lots / pnl
 * are null until greeks and prices arrive. Delta follows the greeks poll; LTP and P&L tick with the live feed.
 */
export default function DeltaSummary({ net, live, updatedAt }) {
  const figure = (value) => (value === null ? '—' : formatCell(value, TWO_DECIMALS));
  return (
    <section className="delta-summary" aria-label="Position P&L and delta">
      <dl className="delta-figures">
        {net.hasPrices && (
          <div>
            <dt>Live P&amp;L</dt>
            <dd className={net.pnl === null ? undefined : signClass(roundTo(net.pnl, 2))}>{figure(net.pnl)}</dd>
          </div>
        )}
        <div>
          <dt>Net delta (qty)</dt>
          <dd>{figure(net.qty)}</dd>
        </div>
        <div>
          <dt>Net delta (lots)</dt>
          <dd>{figure(net.lots)}</dd>
        </div>
        <div>
          <dt>Positions</dt>
          <dd>
            {net.buys} BUY · {net.sells} SELL
          </dd>
        </div>
      </dl>
      <div className="delta-status" role="status">
        <span className={`status-dot is-${live.status}`} aria-hidden="true" />
        <span>{statusText(live, updatedAt)}</span>
      </div>
      {net.missing > 0 && (
        <p className="delta-note">
          {net.missing} row{net.missing === 1 ? ' has' : 's have'} no greeks from Angel One (strike or expiry not
          listed), so {net.missing === 1 ? 'it is' : 'they are'} left out of the net delta.
        </p>
      )}
      {!net.hasPrices && (
        <p className="delta-note">
          No Buy Price and Sell Price columns were found, so the live LTP and P&amp;L are off.
        </p>
      )}
      {net.missingPnl > 0 && (
        <p className="delta-note">
          {net.missingPnl} row{net.missingPnl === 1 ? ' has' : 's have'} no live P&amp;L (no price from Angel One, or
          no entry price in the sheet), so {net.missingPnl === 1 ? 'it is' : 'they are'} left out of the total.
        </p>
      )}
      {net.hasPrices && live.feed.state === 'error' && (
        <p className="delta-note">Live prices: {live.feed.message} The last prices are shown.</p>
      )}
    </section>
  );
}
