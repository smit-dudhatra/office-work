import { useState } from 'react';
import { loginAngel } from '../lib/api.js';

/** Logs the server in to Angel One with the current six-digit TOTP. */
export default function TotpForm() {
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
