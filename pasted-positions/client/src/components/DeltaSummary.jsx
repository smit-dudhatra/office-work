import { useState } from 'react';
import { loginAngel } from '../lib/api.js';
import { formatCell } from '../lib/columns.js';

const TWO_DECIMALS = { type: 'number', decimals: 2 };

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusText(status, message, updatedAt) {
  const at = updatedAt ? ` · updated ${timeLabel(updatedAt)}` : '';
  switch (status) {
    case 'live':
      return `Live from Angel One${at}`;
    case 'closed':
      return `Market closed · last greeks from Angel One${at}`;
    case 'connecting':
      return 'Connecting to Angel One…';
    default:
      return message;
  }
}

function TotpForm() {
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await loginAngel(totp);
      setTotp('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="totp-form" onSubmit={submit}>
      <input
        className="search totp-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="6-digit TOTP"
        aria-label="Angel One TOTP"
        value={totp}
        onChange={(event) => setTotp(event.target.value.replace(/\D/g, ''))}
      />
      <button type="submit" className="btn btn-primary btn-small" disabled={busy || totp.length !== 6}>
        {busy ? 'Logging in…' : 'Log in'}
      </button>
      {error && <span className="totp-error">{error}</span>}
    </form>
  );
}

/**
 * Net delta of the pasted positions, with the live-data status.
 * `net` is { qty, lots, missing, buys, sells } over all rows; qty / lots are null until greeks arrive.
 */
export default function DeltaSummary({ net, live, updatedAt }) {
  const figure = (value) => (value === null ? '—' : formatCell(value, TWO_DECIMALS));
  return (
    <section className="delta-summary" aria-label="Position delta">
      <dl className="delta-figures">
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
        <span>{statusText(live.status, live.message, updatedAt)}</span>
        {live.status === 'needs-login' && <TotpForm />}
      </div>
      {net.missing > 0 && (
        <p className="delta-note">
          {net.missing} row{net.missing === 1 ? ' has' : 's have'} no greeks from Angel One (strike or expiry not
          listed), so {net.missing === 1 ? 'it is' : 'they are'} left out of the net delta.
        </p>
      )}
    </section>
  );
}
