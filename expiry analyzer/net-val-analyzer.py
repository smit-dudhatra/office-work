#!/usr/bin/env python3
"""Expiry-wise Net Val and Net Lot totals from Odin day-wise net position files.

Usage
-----
  python net-val-analyzer.py
  python net-val-analyzer.py "D:\\Trading Data\\Odin File\\2026\\October"
  python net-val-analyzer.py "D:\\...\\September" "D:\\...\\October"

With no folder argument the script reads DEFAULT_FOLDER below. Pass more than
one folder to follow expiries that cross a month boundary; files with identical
contents (e.g. 'October/29 September.xls' and 'September/29.xls') are read once.

Only Ser/Exp, Strike Price, Option Type, Net Val and Net Lot are used. Net Val
and Net Lot are summed per strike and option type, then rolled up per expiry.
Amount is the plain sum of Net Val, so premium on positions that are still
open is included. Total Net Lots keeps its sign: shorts and longs cancel, and
a fully closed expiry shows 0.

After the summary, each expiry that still has an open position gets its own
section listing Strike Price, Option Type (CE/PE) and Net Lots (positive =
net long, negative = net short). Strikes that net to 0 lots are left out.

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

DEFAULT_FOLDER = r'D:\Trading Data\Odin File\2026\check'
FILE_PATTERN = '*.xls'

# Odin column headers. Columns are looked up by name because the order
# differs between exports (2025 files put Net Lot/Net Price first).
COL_EXPIRY = 'Ser/Exp'
COL_STRIKE = 'Strike Price'
COL_OPT_TYPE = 'Option Type'
COL_NET_VAL = 'Net Val'
COL_NET_LOT = 'Net Lot'

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


def read_rows(path):
    """Yield (expiry, row) from one tab-separated Odin export."""
    lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    if not lines:
        return
    header = [name.strip() for name in lines[0].split('\t')]
    missing = [col for col in (COL_EXPIRY, COL_STRIKE, COL_OPT_TYPE,
                               COL_NET_VAL, COL_NET_LOT) if col not in header]
    if missing:
        print(f'  skipped {path.name}: missing column(s) {", ".join(missing)}')
        return
    for line in lines[1:]:
        row = dict(zip(header, line.split('\t')))
        # Separator and '(ALL)' total lines have no expiry date.
        expiry = parse_expiry(row.get(COL_EXPIRY, ''))
        if expiry:
            yield expiry, row


def load_rows(folders, pattern=FILE_PATTERN):
    """Return ([(trade date, expiry, row)], files read, duplicates skipped)."""
    seen = set()
    rows = []
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
                rows.append((trade_date, expiry, row))
    return rows, files_read, duplicates


def strike_totals(rows):
    """Return ({(expiry, strike, option type): {'amount', 'lots'}},
    {expiry: (first trade date, last trade date)})."""
    strikes = defaultdict(lambda: {'amount': 0.0, 'lots': 0})
    dates = {}
    for trade_date, expiry, row in rows:
        key = (expiry, to_float(row.get(COL_STRIKE)),
               row.get(COL_OPT_TYPE, '').strip().upper())
        strikes[key]['amount'] += to_float(row.get(COL_NET_VAL))
        strikes[key]['lots'] += round(to_float(row.get(COL_NET_LOT)))
        first, last = dates.get(expiry, (trade_date, trade_date))
        dates[expiry] = (min(first, trade_date), max(last, trade_date))
    return strikes, dates


def summarize(strikes, dates):
    """Return {expiry: {'amount', 'lots', 'first', 'last'}}."""
    expiries = {}
    for (expiry, _, _), totals in strikes.items():
        summary = expiries.setdefault(expiry, {
            'amount': 0.0, 'lots': 0,
            'first': dates[expiry][0], 'last': dates[expiry][1]})
        summary['amount'] += totals['amount']
        summary['lots'] += totals['lots']
    return expiries


def money(value):
    return f'{value:,.2f}'


def show_day(day):
    return day.strftime('%d-%b-%Y')


def show_expiry(expiry):
    return expiry.strftime('%d%b%Y').upper()


def show_strike(strike):
    return f'{strike:g}'


def print_table(headers, rows, right=(), footer=()):
    widths = [max(len(str(cell)) for cell in column)
              for column in zip(headers, *rows, *footer)]
    rule = '  '.join('-' * width for width in widths)

    def line(cells):
        return '  '.join(str(cell).rjust(width) if i in right
                         else str(cell).ljust(width)
                         for i, (cell, width) in enumerate(zip(cells, widths)))

    print(line(headers))
    print(rule)
    for row in rows:
        print(line(row))
    if footer:
        print(rule)
        for row in footer:
            print(line(row))


def print_summary(expiries):
    rows = [(show_expiry(expiry), money(summary['amount']),
             show_day(summary['first']), show_day(summary['last']),
             summary['lots'])
            for expiry, summary in sorted(expiries.items())]
    rows.append(('TOTAL',
                 money(sum(s['amount'] for s in expiries.values())),
                 '', '', sum(s['lots'] for s in expiries.values())))
    print_table(('Expiry Date', 'Amount', 'First Day Position Found',
                 'Last Day Position Found', 'Total Net Lots'),
                rows, right={1, 4})


def print_open_positions(strikes):
    """One section per expiry listing strikes whose net lots are not 0."""
    open_by_expiry = defaultdict(list)
    for (expiry, strike, opt_type), totals in sorted(strikes.items()):
        if totals['lots']:
            open_by_expiry[expiry].append((strike, opt_type, totals['lots']))

    for expiry, positions in sorted(open_by_expiry.items()):
        ce = sum(lots for _, opt_type, lots in positions if opt_type == 'CE')
        pe = sum(lots for _, opt_type, lots in positions if opt_type == 'PE')
        print(f'\nOPEN POSITION - {show_expiry(expiry)}')
        print_table(('Strike Price', 'Option Type', 'Net Lots'),
                    [(show_strike(strike), opt_type, lots)
                     for strike, opt_type, lots in positions],
                    right={0, 2},
                    footer=[('CE total', '', ce), ('PE total', '', pe),
                            ('TOTAL', '', ce + pe)])


def main():
    parser = argparse.ArgumentParser(
        description='Expiry-wise Net Val and Net Lot totals from Odin files.')
    parser.add_argument('folders', nargs='*', default=[DEFAULT_FOLDER],
                        help=f'folder(s) with Odin files (default: {DEFAULT_FOLDER})')
    parser.add_argument('--pattern', default=FILE_PATTERN,
                        help=f'file name pattern (default: {FILE_PATTERN})')
    args = parser.parse_args()

    for folder in args.folders:
        if not Path(folder).is_dir():
            parser.error(f'folder not found: {folder}')

    rows, files_read, duplicates = load_rows(args.folders, args.pattern)
    print('Folder(s): ' + ', '.join(args.folders))
    print(f'Files read: {files_read}'
          + (f' ({duplicates} duplicate(s) skipped)' if duplicates else '')
          + '\n')
    if not rows:
        print('No trades found.')
        return

    strikes, dates = strike_totals(rows)
    print_summary(summarize(strikes, dates))
    print_open_positions(strikes)


if __name__ == '__main__':
    main()
