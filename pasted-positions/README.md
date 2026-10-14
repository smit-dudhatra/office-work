# Pasted Positions

Paste cells copied from Excel (or a broker's positions page), or drop a spreadsheet, and see them as a table you can sort, filter and export.

- **React + Vite** client in `client/`
- **Express** API in `server/`. It parses the data and returns JSON; nothing is stored.

## Run

```bash
npm install
npm run dev          # API on :5050, UI on http://localhost:5173
```

Production-style (one port):

```bash
npm run build
npm start            # http://localhost:5050
```

## Using it

- **Paste**: press `Ctrl+V` anywhere on the page, or click *Paste from clipboard*.
- **File**: drag a `.xlsx / .xls / .xlsm / .xlsb / .ods / .csv / .tsv / .txt` file (max 10 MB) onto the page, or click *Browse file*. Each sheet of a workbook gets its own tab.
- Click a column header to sort (ascending → descending → off). The filter box matches rows containing all of the words you type.
- **Export CSV** downloads the rows currently shown (filtered and sorted).

## What the parser does

- The header is the first well-filled row; title lines above it are skipped.
- Numbers like `1,234.50`, `12,34,567`, `₹500`, `(2,017.50)` (negative) and `-27.45%` are read as numbers. `-`, `--` and `N/A` count as blank.
- Values that start with a leading zero (`007`) stay as text.
- An existing `Total` / `Grand Total` row is dropped, because the table works out its own totals.

## Totals and colours

These are header-name rules in `client/src/lib/columns.js`:

- **Green / red by sign**: headers containing P&L, PnL, M2M, MTM, profit, loss, gain, realised / unrealised, chg or change.
- **Totals row**: every numeric column except % columns and per-unit ones (LTP, price, avg, strike, open / high / low / close, greeks, chg).
  The totals follow the filter.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/parse/text` | JSON `{ text, html? }` | `{ source, sheets: [{ name, columns, rows, notes }] }` |
| POST | `/api/parse/file` | multipart, field `file` | same |

Errors come back as `{ error }` with status 400.
