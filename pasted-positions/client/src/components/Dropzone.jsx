import { useRef } from 'react';

const ACCEPT = '.xlsx,.xlsm,.xlsb,.xls,.ods,.csv,.tsv,.txt';

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M8 11h8M8 15h8M8 19h5" />
    </svg>
  );
}

export default function Dropzone({ compact, dragging, busy, onFile, onPasteClick }) {
  const inputRef = useRef(null);

  const classes = ['dropzone', compact && 'is-compact', dragging && 'is-dragging', busy && 'is-busy']
    .filter(Boolean)
    .join(' ');

  let title;
  if (busy) title = 'Parsing…';
  else if (dragging) title = 'Drop to load';
  else title = <>Paste with <kbd>Ctrl</kbd> + <kbd>V</kbd> or drop a file here</>;

  return (
    <section className={classes} aria-busy={busy} aria-label="Paste or drop data">
      <div className="dropzone-icon">{busy ? <span className="spinner" /> : <ClipboardIcon />}</div>
      <div className="dropzone-text">
        <p className="dropzone-title">{title}</p>
        <p className="dropzone-hint">
          {compact
            ? 'Paste or drop again to replace the table.'
            : 'Copy cells from Excel or a broker positions page. Files: .xlsx, .xls, .csv, .tsv, .ods up to 10 MB.'}
        </p>
      </div>
      <div className="dropzone-actions">
        <button type="button" className="btn btn-primary" onClick={onPasteClick} disabled={busy}>
          Paste from clipboard
        </button>
        <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>
          Browse file
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
    </section>
  );
}
