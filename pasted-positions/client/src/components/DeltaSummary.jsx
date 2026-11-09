import { formatCell, roundTo, signClass } from '../lib/columns.js';
import { OTM_EXPIRY_VALUE, expiryLabel } from '../lib/positions.js';

const TWO_DECIMALS = { type: 'number', decimals: 2 };
const PERCENT = { type: 'number', decimals: 2, percent: true };

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The hover text of the margin figure: where it came from and how it adds up. */
function marginTitle({ margin, error }) {
  if (!margin) return error || undefined;
  const money = (value) => formatCell(value, TWO_DECIMALS);
  if (!margin.source) return `No margin needed: every position is offset by another · ${timeLabel(margin.at)}`;
  const from = margin.source === 'angel' ? 'Angel One' : 'Upstox';
  const lines = [
    `NRML, from ${from} · ${timeLabel(margin.at)}`,
    `Without margin benefit: ${money(margin.required)}`,
    `Margin benefit (hedges): ${money(margin.benefit)}`,
  ];
  if (margin.span !== null) lines.push(`SPAN: ${money(margin.span)}`);
  if (margin.exposure !== null) lines.push(`Exposure: ${money(margin.exposure)}`);
  if (margin.premium !== null) lines.push(`Option premium (buys): ${money(margin.premium)}`);
  for (const { source, reason } of margin.skipped) lines.push(`${source} not used: ${reason}`);
  return lines.join('\n');
}

/** The hover text of the expiry P&L: what "expires here" means. */
function expiryTitle(net) {
  if (net.spot === null) return 'Waiting for the NIFTY 50 LTP.';
  const settles = net.expiries > 1 ? `the ${expiryLabel(net.nearestExpiry)} options` : 'every option';
  const later = net.expiries > 1 ? '\nLater expiries are at their live LTP, since they would still be trading.' : '';
  return (
    `If NIFTY 50 expired at ${formatCell(net.spot, TWO_DECIMALS)} (its LTP now), ${settles} would be worth what they ` +
    `are in the money (CE: NIFTY − strike, PE: strike − NIFTY), or ₹${OTM_EXPIRY_VALUE.toFixed(2)} out of the money.` +
    later
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.5v3.6H9.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
 * Live P&L, margin and net delta of the pasted positions, with the live-data status.
 * `net` is { qty, lots, pnl, hasPrices, missing, missingPnl, buys, sells } over all rows; qty / lots / pnl
 * are null until greeks and prices arrive. Delta follows the greeks poll; LTP and P&L tick with the live feed.
 * `margin` comes from useMargin.
 */
export default function DeltaSummary({ net, live, updatedAt, margin }) {
  const figure = (value) => (value === null ? '—' : formatCell(value, TWO_DECIMALS));
  const loading = margin.status === 'loading' || margin.status === 'idle';
  const stale = loading || margin.status === 'waiting';
  const final = margin.margin?.final ?? null;
  // The last margin stays on screen, dimmed, while the next one loads or the server can't be reached
  const marginClass = final === null ? undefined : stale ? 'has-tip is-stale' : 'has-tip';
  const returnOnMargin = net.pnl !== null && final > 0 ? (net.pnl / final) * 100 : null;
  return (
    <section className="delta-summary" aria-label="Position P&L, margin and delta">
      <dl className="delta-figures">
        {net.hasPrices && (
          <div>
            <dt>Live P&amp;L</dt>
            <dd className={net.pnl === null ? undefined : signClass(roundTo(net.pnl, 2))}>{figure(net.pnl)}</dd>
          </div>
        )}
        {net.hasPrices && (
          <div>
            <dt>
              Expiry P&amp;L
              {net.expiries > 1 && ` (${expiryLabel(net.nearestExpiry)})`}
              {net.spot !== null && ` @ ${formatCell(net.spot, TWO_DECIMALS)}`}
            </dt>
            <dd
              className={['has-tip', net.expiryPnl !== null && signClass(roundTo(net.expiryPnl, 2))].filter(Boolean).join(' ')}
              title={expiryTitle(net)}
            >
              {net.spot === null ? '…' : figure(net.expiryPnl)}
            </dd>
          </div>
        )}
        <div>
          <dt className="margin-label">
            Margin (NRML)
            <button
              type="button"
              className="refresh-btn"
              onClick={margin.refresh}
              disabled={loading}
              aria-label="Recalculate the margin"
              title="Recalculate the margin"
            >
              <RefreshIcon />
            </button>
          </dt>
          <dd className={marginClass} title={marginTitle(margin)}>
            {final !== null ? figure(final) : stale ? '…' : '—'}
          </dd>
        </div>
        {net.hasPrices && (
          <div>
            <dt>Return on margin</dt>
            <dd className={returnOnMargin === null ? undefined : signClass(roundTo(returnOnMargin, 2))}>
              {returnOnMargin === null ? '—' : formatCell(returnOnMargin, PERCENT)}
            </dd>
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
      {net.hasPrices && net.missingExpiry > 0 && (
        <p className="delta-note">
          {net.missingExpiry} row{net.missingExpiry === 1 ? ' has' : 's have'} no expiry P&amp;L (no entry price in the
          sheet{net.expiries > 1 ? ', or no live price for a later expiry' : ''}), so{' '}
          {net.missingExpiry === 1 ? 'it is' : 'they are'} left out of it.
        </p>
      )}
      {margin.status === 'error' && <p className="delta-note">Margin: {margin.error}</p>}
      {margin.status === 'waiting' && (
        <p className="delta-note">Margin: {margin.error} Trying again every few seconds.</p>
      )}
      {margin.margin?.missing > 0 && (
        <p className="delta-note">
          {margin.margin.missing} row{margin.margin.missing === 1 ? ' is' : 's are'} not in Angel One&rsquo;s
          instrument list (expired, or strike not listed), so {margin.margin.missing === 1 ? 'it is' : 'they are'} left
          out of the margin.
        </p>
      )}
      {net.hasPrices && live.feed.state === 'error' && (
        <p className="delta-note">Live prices: {live.feed.message} The last prices are shown.</p>
      )}
    </section>
  );
}
