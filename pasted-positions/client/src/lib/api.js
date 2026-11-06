/** How long to wait before asking a server that couldn't be reached again. */
export const RETRY_MS = 3000;

/** The server is down or restarting (`npm run dev` restarts it when a server file changes); worth trying again. */
function unreachable() {
  return Object.assign(new Error('Cannot reach the server. Is it running (npm run dev)?'), { unreachable: true });
}

async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw unreachable();
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // The server answers every error with JSON. An empty gateway error comes from the dev proxy, whose server is down.
    if (!body && response.status >= 502 && response.status <= 504) throw unreachable();
    throw new Error(body?.error || `Server error (${response.status})`);
  }
  return body;
}

// The server takes up to 10 MB; past that, leave the HTML out (only cell colours are lost)
const MAX_BODY_BYTES = 9.5 * 1024 * 1024;

/** Send pasted text, plus the clipboard HTML when it holds a table: it carries the cell colours. */
export function parseText(text, html) {
  const withHtml = /<table/i.test(html ?? '') ? JSON.stringify({ text, html }) : null;
  const body = withHtml && new Blob([withHtml]).size <= MAX_BODY_BYTES ? withHtml : JSON.stringify({ text });
  return request('/api/parse/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

/** Log the server in to Angel One with the current six-digit TOTP. */
export function loginAngel(totp) {
  return request('/api/angel/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totp }),
  });
}

/**
 * Margin (NRML) of option positions taken together, so hedges count:
 * positions [{ expiry: '27OCT2026', strike, type: 'CE' | 'PE', quantity, buy }].
 */
export function fetchMargin(positions, signal) {
  return request('/api/margin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions }),
    signal,
  });
}

/** Lot sizes of NIFTY options by expiry: { '27OCT2026': 65 }, null for an expiry Angel One doesn't list. */
export function fetchLotSizes(expiries) {
  return request(`/api/lot-sizes?expiries=${encodeURIComponent(expiries.join(','))}`);
}

export function parseFile(file) {
  const form = new FormData();
  form.append('file', file);
  return request('/api/parse/file', { method: 'POST', body: form });
}
