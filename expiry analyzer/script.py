#!/usr/bin/env python3
"""Expiry-wise P&L from Odin day-wise net position files.

Usage
-----
  python script.py
  python script.py "D:\\Trading Data\\Odin File\\2026\\October"
  python script.py "D:\\...\\September" "D:\\...\\October"
  python script.py "D:\\...\\October" --expiry 06OCT2026

With no folder argument the script reads DEFAULT_FOLDER below. Pass more than
one folder to follow expiries that cross a month boundary; files with identical
contents (e.g. 'October/29 September.xls' and 'September/29.xls') are read once.

Each Odin export holds only that day's trades. Files are processed in date
order and every contract (symbol, expiry, strike, option type) keeps a running
position:

  Net Qty < 0      sell position: opens/adds to a short, or closes a long
  Net Qty > 0      buy position: opens/adds to a long, or closes a short
  Net Qty = 0      intraday trade: Net Val is added to the expiry as-is

When a row has both buys and sells but a non-zero Net Qty, the matched part is
booked as intraday and only the remainder touches the carried position.
Positions are closed against their weighted average price. Quantity that is
never closed is listed as OPEN and kept out of the expiry total.

The trade date comes from the file name ('1.xls', '29 September.xls') plus the
month folder and year folder above it, falling back to the file's modified
time when the name cannot be read.
"""

import argparse
import calendar
import hashlib
import re
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

DEFAULT_FOLDER = r'D:\Trading Data\Odin File\2026\October'
FILE_PATTERN = '*.xls'

# Odin column headers. Columns are looked up by name because the order
# differs between exports (2025 files put Net Lot/Net Price first).
COL_SYMBOL = 'Symbol'
COL_STRIKE = 'Strike Price'
COL_EXPIRY = 'Ser/Exp'
COL_OPT_TYPE = 'Option Type'
COL_SELL_AVG = 'Sell Avg.'
COL_SELL_QTY = 'Sell Qty'
COL_SELL_VAL = 'Sell Val'
COL_BUY_AVG = 'Buy Avg.'
COL_BUY_QTY = 'Buy Qty'
COL_BUY_VAL = 'Buy Val'
COL_NET_QTY = 'Net Qty'
COL_NET_VAL = 'Net Val'

MONTHS = {name.lower()[:3]: num
          for num, name in enumerate(calendar.month_name) if name}


def to_float(text):
    text = (text or '').strip().replace(',', '')
    return float(text) if text else 0.0


def parse_expiry(text):
    try:
        return datetime.strptime(text.strip(), '%d%b%Y').date()
    except ValueError:
        return None


def month_number(text):
    return MONTHS.get(text.strip().lower()[:3])


def file_date(path):
    """Trade date from '<day>[ <month>].xls' inside '<year>/<month>/'."""
    match = re.match(r'\s*(\d{1,2})\s*([A-Za-z]*)', path.stem)
    folder_month = month_number(path.parent.name)
    year_name = path.parent.parent.name
    if match and folder_month and year_name.isdigit():
        day = int(match.group(1))
        month = month_number(match.group(2)) if match.group(2) else folder_month
        year = int(year_name)
        # '30 December.xls' kept in the January folder belongs to last year.
        if month and month > folder_month:
            year -= 1
        try:
            return date(year, month, day)
        except (TypeError, ValueError):
            pass
    return datetime.fromtimestamp(path.stat().st_mtime).date()


def price(row, avg_col, val_col, qty):
    """Exact average from value/qty; the rounded Avg. column is the fallback."""
    value = to_float(row.get(val_col))
    return value / qty if qty and value else to_float(row.get(avg_col))


def read_rows(path):
    """Yield contract rows from one tab-separated Odin export."""
    lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    if not lines:
        return
    header = [name.strip() for name in lines[0].split('\t')]
    if COL_EXPIRY not in header or COL_NET_VAL not in header:
        print(f'  skipped {path.name}: not an Odin net position file')
        return
    for line in lines[1:]:
        row = dict(zip(header, line.split('\t')))
        # Separator and '(ALL)' total lines have no expiry date.
        expiry = parse_expiry(row.get(COL_EXPIRY, ''))
        if expiry:
            yield expiry, row


def load_trades(folders, pattern=FILE_PATTERN):
    """Return (trades sorted by date, files read, duplicates skipped)."""
    seen = set()
    trades = []
    files_read = duplicates = 0
    for folder in folders:
        for path in sorted(Path(folder).glob(pattern)):
            digest = hashlib.md5(path.read_bytes()).hexdigest()
            if digest in seen:
                duplicates += 1
                continue
            seen.add(digest)
            files_read += 1
            trade_date = file_date(path)
            for expiry, row in read_rows(path):
                trades.append((trade_date, expiry, row))
    trades.sort(key=lambda trade: trade[0])
    return trades, files_read, duplicates


class Contract:
    def __init__(self):
        self.position = 0   # signed qty: < 0 short, > 0 long
        self.avg = 0.0
        self.realized = 0.0

    def trade(self, qty, px):
        """Apply a signed qty at px; book P&L on whatever it closes."""
        if self.position == 0 or (self.position > 0) == (qty > 0):
            total = abs(self.position) + abs(qty)
            self.avg = (abs(self.position) * self.avg + abs(qty) * px) / total
            self.position += qty
            return
        closed = min(abs(self.position), abs(qty))
        direction = 1 if self.position > 0 else -1
        self.realized += closed * (px - self.avg) * direction
        self.position += qty
        if self.position == 0:
            self.avg = 0.0
        elif (self.position > 0) != (direction > 0):
            # Trade was larger than the open position and flipped it.
            self.avg = px


def analyze(trades):
    """Return (contracts by key, expiry first/last dates by expiry)."""
    contracts = defaultdict(Contract)
    dates = {}
    for trade_date, expiry, row in trades:
        key = (expiry, row.get(COL_SYMBOL, '').strip(),
               to_float(row.get(COL_STRIKE)), row.get(COL_OPT_TYPE, '').strip())
        contract = contracts[key]
        first, last = dates.get(expiry, (trade_date, trade_date))
        dates[expiry] = (min(first, trade_date), max(last, trade_date))

        net_qty = int(to_float(row.get(COL_NET_QTY)))
        if net_qty == 0:
            contract.realized += to_float(row.get(COL_NET_VAL))
            continue

        sell_qty = int(to_float(row.get(COL_SELL_QTY)))
        buy_qty = int(to_float(row.get(COL_BUY_QTY)))
        sell_px = price(row, COL_SELL_AVG, COL_SELL_VAL, sell_qty)
        buy_px = price(row, COL_BUY_AVG, COL_BUY_VAL, buy_qty)
        intraday_qty = min(sell_qty, buy_qty)
        contract.realized += intraday_qty * (sell_px - buy_px)
        contract.trade(net_qty, sell_px if net_qty < 0 else buy_px)
    return contracts, dates


def money(value):
    return f'{value:,.2f}'


def show_day(day):
    return day.strftime('%d-%b-%Y')


def show_expiry(expiry):
    return expiry.strftime('%d%b%Y').upper()


def show_strike(strike):
    return f'{strike:g}'


def print_table(headers, rows, right=()):
    widths = [max(len(str(cell)) for cell in column)
              for column in zip(headers, *rows)]

    def line(cells):
        return '  '.join(str(cell).rjust(width) if i in right
                         else str(cell).ljust(width)
                         for i, (cell, width) in enumerate(zip(cells, widths)))

    print(line(headers))
    print('  '.join('-' * width for width in widths))
    for row in rows:
        print(line(row))


def print_summary(contracts, dates):
    totals = defaultdict(float)
    open_counts = defaultdict(int)
    for (expiry, *_), contract in contracts.items():
        totals[expiry] += contract.realized
        if contract.position:
            open_counts[expiry] += 1

    rows = [(show_expiry(expiry), money(totals[expiry]),
             show_day(dates[expiry][0]), show_day(dates[expiry][1]),
             open_counts[expiry] or '')
            for expiry in sorted(totals)]
    print_table(('Expiry', 'Total Amount', 'First Position Found On',
                 'Last Position Found On', 'Open Strikes'),
                rows, right={1, 4})
    print(f'\nTotal of all expiries: {money(sum(totals.values()))}')


def print_open_positions(contracts):
    rows = [(show_expiry(expiry), symbol, show_strike(strike), opt_type,
             'SELL' if contract.position < 0 else 'BUY',
             contract.position, f'{contract.avg:.2f}')
            for (expiry, symbol, strike, opt_type), contract
            in sorted(contracts.items()) if contract.position]
    if not rows:
        return
    print('\nOPEN positions (not included in totals above)')
    print_table(('Expiry', 'Symbol', 'Strike', 'Type', 'Side', 'Net Qty',
                 'Avg Price'), rows, right={2, 5, 6})


def print_expiry_detail(contracts, dates, expiry):
    selected = sorted((key, contract) for key, contract in contracts.items()
                      if key[0] == expiry)
    if not selected:
        print(f'No trades found for expiry {show_expiry(expiry)}')
        return
    rows = [(symbol, show_strike(strike), opt_type, money(contract.realized),
             contract.position or '',
             f'{contract.avg:.2f}' if contract.position else '')
            for (_, symbol, strike, opt_type), contract in selected]
    first, last = dates[expiry]
    print(f'Expiry {show_expiry(expiry)}: '
          f'{show_day(first)} to {show_day(last)}\n')
    print_table(('Symbol', 'Strike', 'Type', 'P&L', 'Open Qty', 'Open Avg'),
                rows, right={1, 3, 4, 5})
    total = sum(contract.realized for _, contract in selected)
    print(f'\nTotal Amount: {money(total)}')


def main():
    parser = argparse.ArgumentParser(
        description='Expiry-wise P&L from Odin net position files.')
    parser.add_argument('folders', nargs='*', default=[DEFAULT_FOLDER],
                        help=f'folder(s) with Odin files (default: {DEFAULT_FOLDER})')
    parser.add_argument('--expiry',
                        help='show strike-wise P&L for one expiry, e.g. 06OCT2026')
    parser.add_argument('--pattern', default=FILE_PATTERN,
                        help=f'file name pattern (default: {FILE_PATTERN})')
    args = parser.parse_args()

    expiry = None
    if args.expiry:
        expiry = parse_expiry(args.expiry)
        if not expiry:
            parser.error(f'--expiry {args.expiry!r} is not like 06OCT2026')

    for folder in args.folders:
        if not Path(folder).is_dir():
            parser.error(f'folder not found: {folder}')

    trades, files_read, duplicates = load_trades(args.folders, args.pattern)
    print('Folder(s): ' + ', '.join(args.folders))
    print(f'Files read: {files_read}'
          + (f' ({duplicates} duplicate(s) skipped)' if duplicates else '')
          + '\n')
    if not trades:
        print('No trades found.')
        return

    contracts, dates = analyze(trades)
    if expiry:
        print_expiry_detail(contracts, dates, expiry)
    else:
        print_summary(contracts, dates)
        print_open_positions(contracts)


if __name__ == '__main__':
    main()
