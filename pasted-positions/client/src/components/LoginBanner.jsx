import { useLoginNeeded } from '../lib/angelLogin.js';
import TotpForm from './TotpForm.jsx';

/**
 * The one Angel One login form on the page. Full while live data waits for the login; slim while Upstox
 * supplies the data and the login only gets the Angel fallback ready.
 */
export default function LoginBanner() {
  const needed = useLoginNeeded();
  if (!needed) return null;
  return (
    <section className={`login-banner${needed.slim ? ' is-fallback' : ''}`} aria-label="Angel One login">
      <span className={`status-dot ${needed.slim ? 'is-closed' : 'is-needs-login'}`} aria-hidden="true" />
      <span className="login-banner-text">
        {needed.slim ? "Angel One (the fallback) isn't logged in. Log in so it can take over if Upstox fails." : needed.message}
      </span>
      <TotpForm />
    </section>
  );
}
