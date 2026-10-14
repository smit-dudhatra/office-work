#!/usr/bin/env python3
"""Fetch NSE trading holidays for one year.

Usage
-----
  python nifty-holiday-finder.py

Change YEAR (and SEGMENT if needed) below. SEGMENT 'FO' is the F&O segment
that NIFTY options trade in; NSE also lists CM, CD, COM, IRD and others. The
list matches NSE's holidays page, so it includes holidays that fall on a
weekend. NSE publishes a year's list only near the start of that year.

The script opens the NSE holidays page first so the session picks up fresh
cookies, then calls the same holiday API the page uses. No cookies need to be
pasted.
"""

from datetime import datetime

import requests

YEAR = 2026
SEGMENT = 'FO'

BASE_URL = 'https://www.nseindia.com'
HOLIDAY_PAGE = f'{BASE_URL}/resources/exchange-communication-holidays'
HOLIDAY_API = f'{BASE_URL}/api/holiday-master'
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36')
TIMEOUT = (10, 30)


def nse_session():
    session = requests.Session()
    session.headers.update({'user-agent': USER_AGENT,
                            'accept-language': 'en-US,en;q=0.9'})
    # NSE's bot protection rejects API calls without the cookies this page sets.
    session.get(HOLIDAY_PAGE, timeout=TIMEOUT).raise_for_status()
    return session


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


def main():
    holidays = get_holidays()
    if not holidays:
        print(f'NSE has not published {SEGMENT} trading holidays for {YEAR} yet.')
        return
    print(f'NSE {SEGMENT} trading holidays in {YEAR}: {len(holidays)}')
    for day, description in holidays:
        print(f'  {day:%d-%b-%Y %a}  {description}')


if __name__ == '__main__':
    main()
