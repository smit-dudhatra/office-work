#!/usr/bin/env python3
"""Show how far NIFTY 50 moved between consecutive option expiries in one year.

Requirements
------------
Same dependencies and .env file as angel_nifty_oi.py, plus openpyxl for the
Excel file:

  python -m pip install smartapi-python websocket-client pyotp python-dotenv logzero pycryptodome requests openpyxl

Usage
-----
  python nifty-range-finder.py

Change YEAR (and SYMBOL / INSTRUMENT / SEGMENT if needed) below. The script
fetches the year's expiry dates and the SEGMENT trading holidays from NSE, then
removes every expiry that falls on a holiday or on a Thursday. It prints the
kept expiries, the removed ones with the reason, an expiry-to-expiry table and
a month | expiries table.

Expiry-to-expiry table
----------------------
One row per pair of consecutive kept expiries whose end expiry has already
closed. NIFTY 50 daily candles come from the Angel One SmartAPI.

  Start close  NIFTY 50 close on the start expiry
  End close    NIFTY 50 close on the end expiry
  Difference   end close - start close
  High         highest high from the day after the start expiry through the
               end expiry
  Low          lowest low over the same days
  %            difference / start close * 100
  Up/Down      Up if the end close is above the start close, else Down
  Range        max(start close, High) - min(start close, Low), so a gap after
               the start expiry is included and Range >= |Difference|. It is
               larger than High - Low when NIFTY never traded back to the
               start close.
  Range (%)    range / start close * 100

With EXPORT_EXCEL = True the same table is also saved to
nifty_expiry_summary_<YEAR>.xlsx next to this script, replacing the previous
file. Set it to False to skip the file (openpyxl is then not needed).

Angel login asks for the current six-digit TOTP unless ANGEL_TOTP_SECRET is set
in .env. It is skipped when no expiry-to-expiry period has finished yet. If
Angel sends an empty or non-JSON reply, the error names the step that failed;
the candle request is tried up to CANDLE_ATTEMPTS times first.

get_holidays() is a copy of the one in nifty-holiday-finder.py. For the NSE
APIs the script opens the NSE report page first so the session picks up fresh
cookies. No cookies need to be pasted.
"""

from collections import Counter
from datetime import datetime, time, timedelta, timezone
import getpass
import logging
import os
from pathlib import Path
from time import sleep

import requests

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font
except ImportError:
    Workbook = None

YEAR = 2026
SYMBOL = 'NIFTY'
INSTRUMENT = 'OPTIDX'
SEGMENT = 'FO'
THURSDAY = 3  # date.weekday() value
EXPORT_EXCEL = True
EXCEL_FILE = Path(__file__).resolve().with_name(f'nifty_expiry_summary_{YEAR}.xlsx')

BASE_URL = 'https://www.nseindia.com'
REPORT_PAGE = f'{BASE_URL}/report-detail/fo_eq_security'
HOLIDAY_PAGE = f'{BASE_URL}/resources/exchange-communication-holidays'
EXPIRY_API = f'{BASE_URL}/api/historicalOR/meta/foCPV/expireDts'
HOLIDAY_API = f'{BASE_URL}/api/holiday-master'
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36')
TIMEOUT = (10, 30)

ENV_FILE = Path(__file__).resolve().with_name('.env')
NIFTY_TOKEN = '99926000'  # NIFTY 50 index on NSE
CANDLE_ATTEMPTS = 3  # Angel sometimes sends an empty reply; a later try usually works
RETRY_DELAY = 2  # seconds between tries
IST = timezone(timedelta(hours=5, minutes=30))
MARKET_CLOSE = time(15, 30)

PERIOD_COLUMNS = (('Expiry start', '<', 12), ('Expiry end', '<', 11),
                  ('Start close', '>', 11), ('End close', '>', 9),
                  ('Difference', '>', 10), ('High', '>', 8), ('Low', '>', 8),
                  ('%', '>', 6), ('Up/Down', '<', 7),
                  ('Range', '>', 8), ('Range (%)', '>', 9))
# Excel number format per PERIOD_COLUMNS entry; % columns hold fractions (0.0171 = 1.71%).
EXCEL_FORMATS = ('DD-MMM-YYYY', 'DD-MMM-YYYY', '0.00', '0.00', '+0.00;-0.00;0.00',
                 '0.00', '0.00', '+0.00%;-0.00%;0.00%', 'General', '0.00', '0.00%')


def nse_session():
    session = requests.Session()
    session.headers.update({'user-agent': USER_AGENT,
                            'accept-language': 'en-US,en;q=0.9'})
    # NSE's bot protection rejects API calls without the cookies this page sets.
    session.get(REPORT_PAGE, timeout=TIMEOUT).raise_for_status()
    return session


def get_expiry_dates(year=YEAR, symbol=SYMBOL, instrument=INSTRUMENT, session=None):
    session = session or nse_session()
    response = session.get(
        EXPIRY_API,
        params={'instrument': instrument, 'symbol': symbol, 'year': year},
        headers={'accept': '*/*', 'referer': REPORT_PAGE},
        timeout=TIMEOUT)
    response.raise_for_status()
    try:
        raw = response.json()['expiresDts']
    except (ValueError, KeyError):
        raise RuntimeError(f'Unexpected response from NSE: {response.text[:200]}') from None
    return sorted({datetime.strptime(d, '%d-%b-%Y').date() for d in raw})


def get_holidays(year=YEAR, segment=SEGMENT, session=None):
    """Return sorted (date, description) pairs for one segment and year."""
    session = session or nse_session()
    response = session.get(
        HOLIDAY_API,
        params={'type': 'trading', 'year': year},
        headers={'accept': '*/*', 'referer': HOLIDAY_PAGE},
        timeout=TIMEOUT)
    response.raise_for_status()
    try:
        segments = response.json()
    except ValueError:
        raise RuntimeError(f'Unexpected response from NSE: {response.text[:200]}') from None
    if not segments:
        return []
    if segment not in segments:
        raise RuntimeError(f'Unknown segment {segment!r}; NSE lists {", ".join(segments)}.')
    return sorted((datetime.strptime(h['tradingDate'], '%d-%b-%Y').date(), h['description'])
                  for h in segments[segment])


def split_expiries(expiries, holidays):
    """Split expiries into kept dates and (date, reason) pairs for removed ones."""
    kept, removed = [], []
    for expiry in expiries:
        reasons = []
        if expiry in holidays:
            reasons.append(f'holiday: {holidays[expiry]}')
        if expiry.weekday() == THURSDAY:
            reasons.append('Thursday')
        if reasons:
            removed.append((expiry, ', '.join(reasons)))
        else:
            kept.append(expiry)
    return kept, removed


def require_data(result, operation):
    if not isinstance(result, dict) or not result.get('status') or not result.get('data'):
        # Never print whole API responses: these may contain credentials.
        code = result.get('errorcode', 'unknown') if isinstance(result, dict) else 'unknown'
        raise RuntimeError(f'{operation} failed (code {code}). Check credentials, API access and network.')
    return result['data']


def angel_call(operation, call, *args, attempts=1):
    """Return the data of one SmartAPI call; a failure names the step that failed."""
    for attempt in range(1, attempts + 1):
        try:
            result = call(*args)
        except Exception as exc:
            # The SDK raises DataException when Angel's reply is not JSON, often an
            # empty body that a later try gets past.
            if type(exc).__name__ == 'DataException' and attempt < attempts:
                sleep(RETRY_DELAY)
                continue
            raise RuntimeError(f'{operation} failed: {describe_angel_error(exc)}') from None
        return require_data(result, operation)


def describe_angel_error(exc):
    """Describe a SmartAPI failure without echoing anything that may hold credentials."""
    name = type(exc).__name__
    if name == 'DataException':
        # The SDK appends Angel's raw reply as a bytes literal, such as b''.
        reply = str(exc).partition('server: ')[2]
        if reply == "b''":
            return 'Angel sent an empty reply. Wait a minute and run again.'
        # eyJ starts a JWT; never show a reply that might carry a session token.
        if not reply or 'token' in reply.lower() or 'eyj' in reply.lower():
            return 'Angel sent a reply that is not JSON. Wait a minute and run again.'
        return f'Angel sent a reply that is not JSON: {reply[:150]}'
    if isinstance(exc, requests.RequestException):
        return f'network error ({name}). Check your internet connection.'
    if type(exc).__module__.startswith('SmartApi'):
        # Raised for Angel's own JSON errors, so the message is Angel's text.
        return f'{exc} ({name})'
    return f'unexpected {name} inside the SmartAPI SDK.'


def angel_login():
    try:
        import pyotp
        from dotenv import load_dotenv
        from SmartApi import SmartConnect
    except ImportError:
        raise RuntimeError('Install the dependencies listed at the top of this script.') from None
    # SDK error logs can include authentication request bodies. Keep them private.
    logging.disable(logging.CRITICAL)
    load_dotenv(ENV_FILE)
    def required(name):
        value = os.getenv(name, '').strip()
        if not value:
            raise RuntimeError(f'Set {name} in {ENV_FILE}.')
        return value
    key, client, pin = (required(k) for k in ('ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_PIN'))
    secret = os.getenv('ANGEL_TOTP_SECRET', '').strip()
    otp = pyotp.TOTP(secret).now() if secret else getpass.getpass('Current six-digit TOTP: ').strip()
    if len(otp) != 6 or not otp.isdigit():
        raise RuntimeError('TOTP must contain six digits.')
    api = SmartConnect(api_key=key, timeout=20)
    # Not retried: a second try could fall outside the TOTP's 30-second window.
    angel_call('Login', api.generateSession, client, pin, otp)
    return api


def get_daily_candles(api, start, end):
    """Return {date: (high, low, close)} for NIFTY 50 daily candles from start to end."""
    # Daily candles are stamped at midnight, so a 09:15 start would drop the first day.
    rows = angel_call('NIFTY 50 daily candles', api.getCandleData, {
        'exchange': 'NSE', 'symboltoken': NIFTY_TOKEN, 'interval': 'ONE_DAY',
        'fromdate': f'{start:%Y-%m-%d} 00:00', 'todate': f'{end:%Y-%m-%d} 23:59'},
        attempts=CANDLE_ATTEMPTS)
    # Each row is [timestamp, open, high, low, close, volume].
    return {ist_date(row[0]): (row[2], row[3], row[4]) for row in rows}


def ist_date(timestamp):
    """Return the IST trading date of an Angel timestamp such as 2026-01-06T00:00:00+05:30."""
    stamp = datetime.fromisoformat(timestamp)
    return (stamp.astimezone(IST) if stamp.tzinfo else stamp).date()


def expiry_periods(expiries, candles):
    """Return one row of table values per pair of consecutive expiries."""
    periods = []
    for start, end in zip(expiries, expiries[1:]):
        for day in (start, end):
            if day not in candles:
                raise RuntimeError(
                    f'Angel returned no NIFTY 50 candle for expiry {day:%d-%b-%Y} '
                    f'(got {len(candles)} candles, {min(candles):%d-%b-%Y} to '
                    f'{max(candles):%d-%b-%Y}).')
        start_close, end_close = candles[start][2], candles[end][2]
        days = [candle for day, candle in candles.items() if start < day <= end]
        high = max(high for high, _, _ in days)
        low = min(low for _, low, _ in days)
        # The start close counts as a price too (like ATR's true range), so a gap
        # after the start expiry is part of the range and range >= |difference|.
        price_range = max(start_close, high) - min(start_close, low)
        difference = end_close - start_close
        periods.append((start, end, start_close, end_close, difference, high, low,
                        difference / start_close * 100,
                        'Up' if end_close > start_close else 'Down',
                        price_range, price_range / start_close * 100))
    return periods


def print_period_table(periods):
    def line(cells):
        print(' | '.join(f'{cell:{align}{width}}'
                         for cell, (_, align, width) in zip(cells, PERIOD_COLUMNS)))
    line([title for title, _, _ in PERIOD_COLUMNS])
    print('-+-'.join('-' * width for _, _, width in PERIOD_COLUMNS))
    for (start, end, start_close, end_close, difference, high, low, percent, direction,
         price_range, range_percent) in periods:
        line([f'{start:%d-%b-%Y}', f'{end:%d-%b-%Y}', f'{start_close:.2f}', f'{end_close:.2f}',
              f'{difference:+.2f}', f'{high:.2f}', f'{low:.2f}', f'{percent:+.2f}', direction,
              f'{price_range:.2f}', f'{range_percent:.2f}'])


def write_period_excel(periods, path):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = f'Expiry to expiry {YEAR}'
    sheet.append([title for title, _, _ in PERIOD_COLUMNS])
    for (start, end, start_close, end_close, difference, high, low, percent, direction,
         price_range, range_percent) in periods:
        # Rounded like the console table, so the formula bar shows 1.71% and not 1.70520308...
        sheet.append([start, end, round(start_close, 2), round(end_close, 2),
                      round(difference, 2), round(high, 2), round(low, 2),
                      round(percent / 100, 4), direction,
                      round(price_range, 2), round(range_percent / 100, 4)])
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for column, number_format, (_, _, width) in zip(sheet.iter_cols(), EXCEL_FORMATS, PERIOD_COLUMNS):
        for cell in column[1:]:
            cell.number_format = number_format
        sheet.column_dimensions[column[0].column_letter].width = width + 3
    sheet.freeze_panes = 'A2'
    sheet.auto_filter.ref = sheet.dimensions
    try:
        workbook.save(path)
    except PermissionError:
        raise RuntimeError(f'Cannot write {path.name}; close it in Excel and run again.') from None


def print_month_table(expiries, kept):
    # Months come from all expiries, so a month that lost every expiry shows 0.
    months = sorted({e.replace(day=1) for e in expiries})
    counts = Counter(e.replace(day=1) for e in kept)
    divider = '-' * 9 + '+' + '-' * 9
    print(f'{"Month":<8} | Expiries')
    print(divider)
    for month in months:
        print(f'{month:%b %Y} | {counts[month]:>8}')
    print(divider)
    print(f'{"Total":<8} | {len(kept):>8}')


def main():
    # Fail before the TOTP prompt rather than after the Angel login.
    if EXPORT_EXCEL and Workbook is None:
        raise RuntimeError('EXPORT_EXCEL needs openpyxl: python -m pip install openpyxl '
                           '(or set EXPORT_EXCEL = False).')
    session = nse_session()
    expiries = get_expiry_dates(session=session)
    holidays = dict(get_holidays(session=session))
    kept, removed = split_expiries(expiries, holidays)

    now = datetime.now(IST)
    finished = [e for e in kept
                if e < now.date() or (e == now.date() and now.time() >= MARKET_CLOSE)]
    periods = []
    if len(finished) >= 2:
        candles = get_daily_candles(angel_login(), finished[0], finished[-1])
        periods = expiry_periods(finished, candles)

    if not holidays:
        print(f'NSE has not published {SEGMENT} trading holidays for {YEAR} yet; '
              'only Thursdays are removed.\n')
    print(f'{SYMBOL} {INSTRUMENT} expiries in {YEAR}: {len(kept)} kept of {len(expiries)}')
    for expiry in kept:
        print(f'  {expiry:%d-%b-%Y %a}')

    print(f'\nRemoved: {len(removed)}')
    for expiry, reason in removed:
        print(f'  {expiry:%d-%b-%Y %a}  {reason}')

    print()
    if periods:
        print(f'NIFTY 50 expiry to expiry: {len(periods)} finished periods')
        print_period_table(periods)
    else:
        print(f'No expiry-to-expiry period in {YEAR} has finished yet.')

    print()
    print_month_table(expiries, kept)

    if EXPORT_EXCEL and periods:
        write_period_excel(periods, EXCEL_FILE)
        print(f'\nSaved the expiry-to-expiry table to {EXCEL_FILE.name}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nStopped.')
    except RuntimeError as exc:
        print(f'Error: {exc}')
        raise SystemExit(1)
    except Exception as exc:
        # Avoid dumping credentials from third-party exception messages.
        print(f'Error ({type(exc).__name__}). Check configuration, connectivity and API access.')
        raise SystemExit(1)
