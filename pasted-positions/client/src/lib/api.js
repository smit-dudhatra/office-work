async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('Cannot reach the server. Is it running (npm run dev)?');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Server error (${response.status})`);
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

export function parseFile(file) {
  const form = new FormData();
  form.append('file', file);
  return request('/api/parse/file', { method: 'POST', body: form });
}
