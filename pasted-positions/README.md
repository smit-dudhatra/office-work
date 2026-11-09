# Pasted Positions

Paste cells copied from Excel (or a broker's positions page), or drop a spreadsheet, and see them as a table you can sort, filter and export.

- **React + Vite** client in `client/`
- **Express** API in `server/`. It parses the data and returns JSON; nothing is stored.

## Run

```bash
npm install
npm run dev          # API on :5050, UI on http://localhost:5173
```

The API restarts when a file in `server/` changes, and the terminal says which one (`Change detected in …`). It
doesn't watch `node_modules`, so restart `npm run dev` after an `npm install`. While it restarts, the UI's dev proxy
logs `http proxy error … ECONNRESET` / `ECONNREFUSED` for the requests it cut off; that is expected. The live
streams reconnect by themselves, and the margin and lot sizes are asked for again every 3 seconds until the API is back.

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
- **Delta** comes with every Upstox tick of the option (see [Data sources](#data-sources)). On the Angel One
  fallback it comes from Angel's option-greeks API instead, every 3 seconds during market hours (09:15–15:40 IST)
  and every minute outside them. Put deltas are negative.
- **Delta (qty)** = option delta × quantity, positive for BUY and negative for SELL. **Delta (lots)** divides by the
  lot size (from the sheet, else Angel's instrument list). The summary above the table shows the net for every row;
  the Total row follows the filter.
- An expiry without a year means the nearest such date (`27-Oct` → 27-Oct-2026).

### Live LTP and P&L

When the table also has **Buy Price** and **Sell Price** columns (headers with `buy` / `sell` and `price`, `avg` or
`rate`; `Buy @` and `Sell @` are not matched), each row's option price comes tick by tick from the live feed
(see [Data sources](#data-sources)), so the LTP and P&L move on every trade.

- A **BUY**'s entry is its Buy Price, so the LTP is shown in its **Sell Price** cell. A **SELL**'s entry is its Sell
  Price, so the LTP is shown in its **Buy Price** cell. The pasted value in that cell is replaced on screen (the
  tooltip shows it) and the cell is italic with an accent edge. Flipping a row's side moves the LTP to the other column.
- **P&L** = (sell price − buy price) × quantity, with the LTP as the missing leg. It appears in a **Live P&L** column
  (next to the deltas), in the Total row, and as **Live P&L** at the top of the table. A pasted `P&L` column is
  recomputed in place; `Rs.`, `Multiple` and `%` stay as pasted.
- A row with no price from Angel One, or no entry price in the sheet, keeps its pasted cells and is left out of the
  total (a note says how many).
- Each strike is priced once over the quote API when it first appears, so outside market hours the LTP is the last
  close. CSV export has the live values.
- Symbol tokens come from Angel's `OpenAPIScripMaster.json`. It is read from the folder above this one (shared with
  `angel_nifty_oi.py`) and downloaded again when it wasn't written today.

### Expiry P&L

**Expiry P&L @ <NIFTY LTP>** in the header is the P&L if NIFTY 50 expired at its LTP now. It moves with every NIFTY
tick (the same live price as the daily analysis card).

- Each option of the nearest expiry in the sheet is worth what it would settle at: in the money, CE = NIFTY − strike
  and PE = strike − NIFTY; out of the money (or less than a rupee in), ₹1.00. That value is the missing leg, as the
  LTP is for Live P&L: P&L = (sell − buy) × quantity, with each row's side (flips included).
- Options of later expiries would still be trading, so they count at their live LTP (their Live P&L). The label then
  names the expiry that settles, e.g. *Expiry P&L (09 Nov)*.
- Like Live P&L, it needs the Buy Price and Sell Price columns; a row with no entry price is left out, and a note says
  how many.

### Margin

The header shows the **Margin (NRML)** the positions need. The broker works it out for all of them together, so hedges
(e.g. a call bought above a sold one) lower it, as they would in the account. **Return on margin** = Live P&L ÷ margin.

- A broker counts a hedge only between options in the same request, so all of them always go in one request. Which
  broker depends on the number of legs (options left after netting, see below):
  - **up to 20**: Upstox (product `D`), or Angel One if Upstox fails;
  - **21–50**: Angel One only (`CARRYFORWARD`), since Upstox takes at most 20 instruments per request.
- More than 50 legs, or 21–50 while Angel One isn't logged in, can't be worked out: the margin shows **—** and a note
  says why (legs exceed the limit of 50, or Angel One login is not done).
- Each row counts with the side it shows, so flipping a row's BUY / SELL works the margin out again. Rows of the same
  option are netted first: a BUY and a SELL of it offset each other.
- It's worked out when the sheet is pasted, when a side is flipped, and when you press ↻ next to it. It doesn't
  follow the market by itself; press ↻ for a fresh figure. While a new one loads, the last one stays, dimmed.
- **Margin details**, a row under the header, opens the broker's calculation: SPAN + exposure + premium of the bought
  options = margin without the hedge benefit, − the hedge benefit = the final margin, with where and when it was worked
  out. A part the broker doesn't list separately shows as *Other* (Angel One gives no exposure figure, so for it the
  line is *Exposure & other*). Whether the row is open is remembered in this browser. Hovering the margin figure
  shows the same numbers.
- A row whose option isn't in Angel's instrument list (expired, or a strike that isn't listed) is left out of the
  margin, and a note says how many.

### Lots by side and CE / PE

A small table under the header counts the lots of every position by side (SELL / BUY rows) and option type
(CE / PE columns), with totals. It counts every position, whatever the filter.

- A row counts with the side it shows, so flipping its BUY / SELL moves its lots to the other row.
- Lots = quantity ÷ lot size. The lot size is the sheet's **Lot Size** column, else the one Angel's instrument list
  gives for the expiry (the same goes for **Delta (lots)**). A row with neither is left out, and a note says how many.

## NIFTY 50 daily analysis

A card at the top of the page compares the NIFTY 50 LTP with levels on the daily timeframe. It updates on every
tick (see [Data sources](#data-sources)) and can be hidden (the choice is remembered in this browser).

| Row | Status | Bias | Value |
| --- | --- | --- | --- |
| Prev Day Low / Close / High | Above or Below (LTP ≥ level is Above) | Above Bullish, Below Bearish | the previous session's low / close / high |
| LTP vs Prev Green Low | Above or Below | Above Bullish, Below Bearish | low of the latest green day (close > open) before today |
| LTP vs Prev Red High | Above or Below | Above Bullish, Below Bearish | high of the latest red day (close < open) before today |
| Prev Week Low / Close / High | Above or Below | Above Bullish, Below Bearish | the previous calendar week's low, last close and high |
| Current Candle (today up or down) | Green when LTP ≥ today's open, else Red | Green Bullish, Red Bearish | — |
| Previous Candle | Green or Red | Green Bullish, Red Bearish | — |
| Near To High (Bullish) | (today's high − LTP) ÷ LTP | Bullish under 0.25%, else Neutral | today's high |
| Near To Low (Bearish) | (LTP − today's low) ÷ LTP | Bearish under 0.25%, else Neutral | today's low |
| Is Inside Candle? (Sideways) | Yes when today's high and low are within the previous day's | Yes Sideways, No Neutral | — |
| At All-Time High? | Yes when LTP ≥ the highest high before today | Yes Bullish, No Neutral | the highest high, today's included |
| Distance From All-Time High | (all-time high − LTP) ÷ LTP | Bullish under 2%, else Neutral | the all-time high |
| Distance From 52-Week Low | (LTP − 52-week low) ÷ LTP | Bearish under 2%, else Neutral | lowest low since the same date a year back, today's included |
| LTP vs 5 / 21 / 252 EMA | Above or Below | Above Bullish, Below Bearish | EMA of daily closes, with the LTP as today's close |
| 5 vs 21 EMA Distance | (5 EMA − 21 EMA) ÷ LTP | positive Bullish, negative Bearish | — |

The card's header counts the rows by bias and gives a verdict: Bullish or Bearish, whichever has more rows, or
Neutral when they're even (sideways and neutral rows don't count towards either side).

- Past candles come from Upstox's historical-candle API (Angel One's on the fallback), loaded once a day, back as
  far as the source has them (the all-time high's tooltip says from when; Upstox goes back to 1990). A candle for
  today in that data is ignored; today's candle is the live one.
- When the market is closed, the last session is shown, and the card says so.

## Data sources

**Upstox** is the main source. The server holds one Upstox V3 market-data WebSocket with the NIFTY 50 index (full
mode: LTP with the day's open, high and low) and the option strikes of the pasted table (`option_greeks` mode: LTP,
delta and IV on every tick), and loads daily candles from its historical-candle API (ten years per request). The
WebSocket address is fetched from Upstox's authorize endpoint on each connect (the feed URL redirects there, which
a WebSocket can't follow). It opens while a page needs it, reconnects with backoff (2s up to a minute) when it
drops, and closes when no page is open. Pages get at most four updates a second. Upstox needs
`UPSTOX_ACCESS_TOKEN` in `.env` (the same one `upstox-webscoket.py` uses): the 1-year read-only Analytics Token from
the Upstox Developer Apps page, or a daily access token (expires around 3:30 AM IST).

**Angel One** is the fallback. It takes over when Upstox has no token, refuses the connection, or its feed fails
three times in a row: the NIFTY 50 index (Quote mode) and the strikes (LTP mode) over its SmartStream WebSocket
(pinged every 10 seconds), daily candles and a quote over REST, and delta from the 3-second greeks poll. Upstox is
retried in the background meanwhile, and the app goes back to it as soon as its feed is up. Status lines say
*Live from Upstox* or *Live from Angel One (fallback)*.

While Angel isn't logged in, a slim banner keeps the TOTP form at the top of the page, so the fallback is ready
before Upstox ever fails. If Upstox fails while Angel isn't logged in, the banner becomes the full one and says why
Upstox is unavailable.

Option instrument keys on Upstox are `NSE_FO|<NSE token>`, the token Angel uses, so one instrument list (Angel's)
serves both.

Market hours here are 09:15–15:40 IST on weekdays (holidays aren't known).

Angel One credentials are read from this folder's `.env`, else from the one in the folder above (shared with the
Python scripts): `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN` and, optionally, `ANGEL_TOTP_SECRET`.
With the secret, the server logs in by itself. Without it, a banner at the top of the page asks for the current
six-digit TOTP (one login serves the daily analysis, the positions and the live feed), and the login only works
from the computer running the server. The session lasts until Angel expires it, or until the server restarts
(`npm run dev` restarts it whenever a server file changes).
`ANGEL_GREEKS_POLL_SECONDS` changes the 3-second interval.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/parse/text` | JSON `{ text, html? }` | `{ source, sheets: [{ name, columns, rows, notes, fills? }] }` |
| POST | `/api/parse/file` | multipart, field `file` | same |
| GET | `/api/greeks/stream?expiries=27OCT2026&quotes=27OCT2026:22050PE` | — | server-sent events: `status` `{ state, message, source, angelLogin }` (greeks), `feed` `{ state, message }` (WebSocket), `greeks` `{ expiry, fetchedAt, strikes: { '22050PE': { delta, iv } } }`, `ltps` `{ expiry, ltps: { '22050PE': price \| null } }` (changed strikes only) |
| GET | `/api/daily/stream` | — | server-sent events: `status` `{ state, message, source, angelLogin }`, `daily` `{ symbol, updatedAt, date, ltp, today, prevDay, prevWeek, prevGreen, prevRed, allTimeHigh, low52Week, ema }` |
| POST | `/api/margin` | JSON `{ positions: [{ expiry: '27OCT2026', strike, type: 'CE' \| 'PE', quantity, buy }] }` | `{ source: 'upstox' \| 'angel' \| null, final, required, benefit, span, exposure, premium, legs, missing, skipped: [{ source, reason }], at }` (`final` is after the margin benefit; `source` is null when every position is offset). More than 50 legs is a 400, Angel One not logged in for 21–50 legs a 503 |
| GET | `/api/lot-sizes?expiries=27OCT2026,03NOV2026` | — | `{ '27OCT2026': 65 }`, null for an expiry Angel One doesn't list |
| POST | `/api/angel/login` | JSON `{ totp }` | `{ ok: true }` |

`fills` is only present when some data cell has a colour. It has the same shape as `rows`, and each entry is
`'#RRGGBB'` or `null`.

Errors come back as `{ error }` with status 400.
