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

/** Send pasted text; the HTML is only useful when there are no tabs (copied from a web page). */
export function parseText(text, html) {
  const sendHtml = !text.includes('\t') && /<table/i.test(html ?? '');
  return request('/api/parse/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, html: sendHtml ? html : undefined }),
  });
}

export function parseFile(file) {
  const form = new FormData();
  form.append('file', file);
  return request('/api/parse/file', { method: 'POST', body: form });
}
