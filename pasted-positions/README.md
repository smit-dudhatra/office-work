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

## Cell background colours

Data cells keep their background colour (header cells keep the app's style). White counts as no fill.

- **Pasted from Excel / Google Sheets**: the colours as shown, including conditional formatting. They come from the
  clipboard's HTML copy, which is matched cell by cell against the pasted text; if they don't line up, a note says
  the colours were left out.
- **Pasted from a web page**: the cell's (or its row's) background, if the page sets one. Translucent colours are
  blended onto white.
- **Files**: fills set on cells in `.xlsx` / `.xlsm` / `.xls`. Conditional formatting is not evaluated in files.
  For those colours, copy the cells from Excel and paste them instead.

Text on a coloured cell is dark or light, whichever reads better on that colour, in both themes. P&L cells keep
their green / red when it is readable on the fill. CSV export has no colours.

## Live position delta (NIFTY options)

When the pasted table has an **Expiry** column (e.g. `27-Oct`), a **Strike** column, a CE / PE column and a
quantity (**Total Lot Size**, **Qty**, or **Lot Size** × **No. Lot**), each row is read as a NIFTY option position:

- **Side**: a row is a **BUY** when most of its cells are filled yellow, otherwise a **SELL**. Click the BUY / SELL
  tag to flip a row (a dashed outline marks rows changed by hand).
- **Delta** comes from Angel One's option-greeks API and refreshes every 3 seconds during market hours
  (09:15–15:30 IST), and every minute outside them. Put deltas are negative.
- **Delta (qty)** = option delta × quantity, positive for BUY and negative for SELL. **Delta (lots)** divides by the
  lot size. The summary above the table shows the net for every row; the Total row follows the filter.
- An expiry without a year means the nearest such date (`27-Oct` → 27-Oct-2026).

Angel One credentials are read from this folder's `.env`, else from the one in the folder above (shared with the
Python scripts): `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN` and, optionally, `ANGEL_TOTP_SECRET`.
With the secret, the server logs in by itself. Without it, the app asks for the current six-digit TOTP, and the
login only works from the computer running the server. The session lasts until Angel expires it.
`ANGEL_GREEKS_POLL_SECONDS` changes the 3-second interval.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/parse/text` | JSON `{ text, html? }` | `{ source, sheets: [{ name, columns, rows, notes, fills? }] }` |
| POST | `/api/parse/file` | multipart, field `file` | same |
| GET | `/api/greeks/stream?expiries=27OCT2026` | — | server-sent events: `status` `{ state, message }`, `greeks` `{ expiry, fetchedAt, strikes: { '22050PE': { delta, iv } } }` |
| POST | `/api/angel/login` | JSON `{ totp }` | `{ ok: true }` |

`fills` is only present when some data cell has a colour. It has the same shape as `rows`, and each entry is
`'#RRGGBB'` or `null`.

Errors come back as `{ error }` with status 400.
