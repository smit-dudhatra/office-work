import { useCallback, useEffect, useRef, useState } from 'react';
import DataTable from './components/DataTable.jsx';
import Dropzone from './components/Dropzone.jsx';
import { parseFile, parseText } from './lib/api.js';

function isEditable(target) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]'));
}

function hasDropPayload(event) {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes('Files') || types.includes('text/plain');
}

/** Clipboard text, and its HTML (which carries cell colours) where the browser lets us read it. */
async function readClipboard() {
  try {
    // Unsanitized: the same HTML a Ctrl+V paste gets, with Excel's <style> block intact
    const items = await navigator.clipboard.read({ unsanitized: ['text/html'] });
    const item = items.find((entry) => entry.types.includes('text/plain'));
    if (item) {
      const read = async (type) => (item.types.includes(type) ? (await item.getType(type)).text() : '');
      return { text: await read('text/plain'), html: await read('text/html') };
    }
  } catch {
    // Older browsers can only read plain text
  }
  return { text: await navigator.clipboard.readText(), html: '' };
}

function timeLabel(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function exportName(result, sheet) {
  let base;
  if (result.source.kind === 'paste') {
    const d = result.receivedAt;
    const pad = (n) => String(n).padStart(2, '0');
    base = `pasted-positions-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  } else {
    base = result.source.name.replace(/\.[^.]+$/, '');
    if (result.sheets.length > 1) base += `-${sheet.name}`;
  }
  return base.replace(/[\\/:*?"<>|]+/g, '-');
}

export default function App() {
  const [result, setResult] = useState(null); // { id, source, sheets, receivedAt }
  const [sheetIndex, setSheetIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const latestRequest = useRef(0);

  // Only the most recent paste/drop wins if several are in flight
  const run = useCallback(async (request) => {
    const id = ++latestRequest.current;
    setBusy(true);
    setError('');
    try {
      const data = await request();
      if (id !== latestRequest.current) return;
      setResult({ ...data, id, receivedAt: new Date() });
      setSheetIndex(0);
    } catch (err) {
      if (id === latestRequest.current) setError(err.message);
    } finally {
      if (id === latestRequest.current) setBusy(false);
    }
  }, []);

  const handleText = useCallback((text, html) => run(() => parseText(text, html)), [run]);
  const handleFile = useCallback((file) => run(() => parseFile(file)), [run]);

  // Ctrl+V anywhere on the page (except inside the filter box)
  useEffect(() => {
    function onPaste(event) {
      if (isEditable(event.target) || !event.clipboardData) return;
      const { clipboardData } = event;
      // Excel also puts a picture of the cells on the clipboard, so prefer the text
      const text = clipboardData.getData('text/plain');
      if (text.trim()) {
        event.preventDefault();
        handleText(text, clipboardData.getData('text/html'));
      } else if (clipboardData.files.length) {
        event.preventDefault();
        handleFile(clipboardData.files[0]);
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleText, handleFile]);

  // The whole window is a drop target, so a near-miss drop doesn't open the file in the browser
  useEffect(() => {
    let depth = 0;
    function onDragEnter(event) {
      if (!hasDropPayload(event)) return;
      depth += 1;
      setDragging(true);
    }
    function onDragLeave(event) {
      if (!hasDropPayload(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    }
    function onDragOver(event) {
      if (!hasDropPayload(event) || isEditable(event.target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(event) {
      depth = 0;
      setDragging(false);
      if (!hasDropPayload(event) || isEditable(event.target)) return;
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (file) {
        handleFile(file);
        return;
      }
      const text = event.dataTransfer.getData('text/plain');
      if (text.trim()) handleText(text, event.dataTransfer.getData('text/html'));
    }
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleText, handleFile]);

  async function pasteFromClipboard() {
    let clipboard;
    try {
      clipboard = await readClipboard();
    } catch {
      setError('The browser blocked clipboard access. Press Ctrl+V on the page instead.');
      return;
    }
    if (!clipboard.text.trim()) {
      setError('The clipboard is empty. Copy some cells first.');
      return;
    }
    handleText(clipboard.text, clipboard.html);
  }

  function clear() {
    latestRequest.current += 1;
    setBusy(false);
    setResult(null);
    setError('');
  }

  const sheet = result?.sheets[sheetIndex];
  const title = result
    ? result.source.kind === 'paste'
      ? `Pasted at ${timeLabel(result.receivedAt)}`
      : result.source.name
    : '';

  return (
    <div className="page">
      <header className="page-header">
        <h1>Pasted Positions</h1>
        <p>Paste a block of cells copied from Excel or a web page, or drop a spreadsheet, to see it as a table.</p>
      </header>

      <Dropzone
        compact={Boolean(result)}
        dragging={dragging}
        busy={busy}
        onFile={handleFile}
        onPasteClick={pasteFromClipboard}
      />

      {error && (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}

      {result && sheet && (
        <section className="results" aria-label="Parsed data">
          {result.sheets.length > 1 && (
            <div className="sheet-tabs" role="tablist" aria-label="Sheets">
              {result.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  aria-selected={i === sheetIndex}
                  className="sheet-tab"
                  onClick={() => setSheetIndex(i)}
                >
                  {s.name}
                  <span className="sheet-tab-count">{s.rows.length}</span>
                </button>
              ))}
            </div>
          )}
          <DataTable
            key={`${result.id}-${sheetIndex}`}
            sheet={sheet}
            title={title}
            exportName={exportName(result, sheet)}
            onClear={clear}
          />
        </section>
      )}
    </div>
  );
}
