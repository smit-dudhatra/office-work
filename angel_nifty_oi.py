#!/usr/bin/env python3
"""Collect and store live NIFTY option open-interest PCR snapshots.

Requirements
------------
Python 3.10+, an Angel One SmartAPI account with market-data access, and:

  python -m pip install smartapi-python websocket-client pyotp python-dotenv logzero pycryptodome requests

Initial setup
-------------
Create the environment template, fill in the credentials, and start the feed:

  python angel_nifty_oi.py --init-env
  python angel_nifty_oi.py

The default .env file is stored beside this script and contains:

  ANGEL_API_KEY       SmartAPI application key.
  ANGEL_CLIENT_CODE   Angel One client code.
  ANGEL_PIN           Account PIN.
  ANGEL_TOTP_SECRET   Optional authenticator setup secret. If omitted, the
                      current six-digit TOTP is requested securely at startup.

Market and strike selection
---------------------------
The script downloads the Angel One instrument master and resolves NIFTY 50 spot.
Unless --expiry is supplied, it uses the nearest unexpired NIFTY option expiry.
An expiry on the current day is excluded from 15:30 IST onward. Only listed
strikes having both CE and PE contracts are eligible.

ATM is the eligible strike nearest to the latest NIFTY spot price. An exact
midpoint tie selects the higher strike. By default, ATM plus five listed strikes
below and five above are tracked (11 strikes and 22 option tokens). The count on
each side is controlled by --strikes-each-side/--strikes; use zero for ATM only.

Every --strike-interval minutes (default 1), the latest NIFTY spot is requested.
If the ATM group changes, the old WebSocket tokens are unsubscribed, the new CE/PE
tokens are subscribed, and cached OI for the old group is cleared.

PCR calculation, JSON, and terminal output
------------------------------------------
For every tracked strike:

  PCR = Put open interest / Call open interest

The JSON stores the raw ratio (it does not multiply by 100). Missing OI and zero
Call OI produce null in JSON. The terminal does not print per-strike PCR. At each
snapshot it ranks the latest raw OI and shows the three highest Put strikes and
the three highest Call strikes. OI ties are ordered by ascending strike. Example:

  [13:43:59] Top 3 PUT OI: 1) 22500: 1,234,567 | 2) 22450: 1,100,000 | 3) 22400: 950,000
  [13:43:59] Top 3 CALL OI: 1) 22600: 1,300,000 | 2) 22650: 1,050,000 | 3) 22700: 900,000

Missing sides are omitted from their ranking, and N/A is printed when none are
available. Option LTP values are decoded but are not printed.

Snapshot timing
---------------
--interval controls both terminal output and JSON snapshots in minutes (default
1, minimum one second). Scheduling is aligned to wall-clock interval ends rather
than script start time. Thus an interval of 1 writes at HH:MM:59, and an interval
of 5 writes at HH:04:59, HH:09:59, and so on. Nothing is written immediately at
startup. The latest cached OI is used at each boundary.

Daily JSON storage
------------------
--json-file is a base path. The IST trading date is inserted before its suffix:

  nifty_pcr.json -> nifty_pcr_2026-10-05.json

Restarting during the same day reads and appends to that day's JSON array. A new
date uses a new file, preserving earlier days. Writes use a temporary file and an
atomic replacement. Each snapshot has this shape:

  {
    "timestamp": "2026-10-05T13:43:59+05:30",
    "atm_strike": 22550,
    "strikes": [
      {"strike": 22550, "is_atm": true, "pcr": 0.63}
    ]
  }

Command-line configuration
--------------------------
--env PATH
    Credential file. Default: .env beside this script.
--expiry YYYY-MM-DD
    Fixed option expiry. Default: nearest eligible expiry.
--interval MINUTES
    Aligned terminal/JSON snapshot interval. Default: 1.
--strike-interval MINUTES
    NIFTY spot and ATM group refresh interval. Default: 1.
--strikes-each-side COUNT, --strikes COUNT
    Listed strikes below and above ATM. Default: 5.
--json-file PATH
    Base JSON filename; the date is inserted automatically. Default:
    nifty_pcr.json beside this script.
--init-env
    Create the environment template without overwriting an existing file.
--self-test
    Run offline selection, timing, path, and binary-decoding checks.

Examples
--------
  python angel_nifty_oi.py
  python angel_nifty_oi.py --strikes 3 --interval 1
  python angel_nifty_oi.py --strike-interval 2 --expiry 2026-10-08
  python angel_nifty_oi.py --json-file data/nifty_history.json

Operational notes
-----------------
Times use IST. OI is the broker's unscaled open_interest field and is never
silently replaced by zero. Outside market hours, spot quotes may be stale and
option ticks may not arrive. WebSocket disconnects are retried with backoff. The
program places no orders, stops on Ctrl+C or a date change, and should be restarted
for each trading day/session.

Protocol reference: https://github.com/angel-one/smartapi-python
"""

import argparse
from datetime import date, datetime, time as clock_time, timedelta, timezone
from decimal import Decimal
import getpass
import json
import logging
import os
from pathlib import Path
import signal
import struct
import threading
import time

IST = timezone(timedelta(hours=5, minutes=30))
MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'
WS_URL = 'wss://smartapisocket.angelone.in/smart-stream'
TOP_OI_COUNT = 3
ENV_TEMPLATE = '''# Keep this file private. Do not commit it to Git.
ANGEL_API_KEY=
ANGEL_CLIENT_CODE=
ANGEL_PIN=
# Optional authenticator setup secret (NOT the changing six-digit code).
# Leave blank to enter the current six-digit TOTP securely at startup.
ANGEL_TOTP_SECRET=
'''


def select_strikes(rows, spot, now, strikes_each_side, requested_expiry=None):
    """Select ATM and nearby complete CE/PE pairs from actual listed strikes."""
    groups = {}
    for row in rows:
        if (row.get('exch_seg') != 'NFO' or row.get('name') != 'NIFTY'
                or row.get('instrumenttype') != 'OPTIDX'):
            continue
        side = str(row.get('symbol', ''))[-2:]
        if side not in ('CE', 'PE'):
            continue
        try:
            expiry = datetime.strptime(row['expiry'], '%d%b%Y').date()
            strike = Decimal(row['strike']) / 100
        except (KeyError, ValueError, ArithmeticError):
            continue
        if (expiry < now.date() or
                (expiry == now.date() and now.time() >= clock_time(15, 30))):
            continue
        if requested_expiry and expiry != requested_expiry:
            continue
        if not strike.is_finite() or strike <= 0 or not row.get('token'):
            continue
        groups.setdefault(expiry, {}).setdefault(strike, {})[side] = row
    if not groups:
        raise RuntimeError('No eligible NIFTY options found. Check expiry and instrument master.')
    expiry = min(groups)
    complete = {k: v for k, v in groups[expiry].items() if set(v) == {'CE', 'PE'}}
    if not complete:
        raise RuntimeError('Nearest expiry has no matching CE/PE strike pair.')
    ordered = sorted(complete)
    atm_strike = min(ordered, key=lambda k: (abs(k - spot), -k))
    atm_index = ordered.index(atm_strike)
    if (atm_index < strikes_each_side or
            len(ordered) - atm_index - 1 < strikes_each_side):
        raise RuntimeError(
            f'Not enough complete strikes to select {strikes_each_side} on each side of ATM.')
    selected = ordered[atm_index - strikes_each_side:
                       atm_index + strikes_each_side + 1]
    pairs = {strike: [complete[strike]['CE'], complete[strike]['PE']]
             for strike in selected}
    return expiry, atm_strike, pairs


def select_pair(rows, spot, now, requested_expiry=None):
    """Compatibility helper that selects only the nearest ATM CE/PE pair."""
    expiry, strike, pairs = select_strikes(rows, spot, now, 0, requested_expiry)
    return expiry, strike, pairs[strike]


def parse_tick(packet):
    """Read only NSE F&O SNAP_QUOTE fields needed here, little-endian."""
    if len(packet) < 139 or packet[0] != 3 or packet[1] != 2:
        return None
    return {
        'token': packet[2:27].split(b'\0', 1)[0].decode('ascii'),
        'timestamp': struct.unpack_from('<q', packet, 35)[0],
        'ltp': struct.unpack_from('<q', packet, 43)[0] / 100,
        'oi': struct.unpack_from('<q', packet, 131)[0],
    }


def require_data(result, operation):
    if not isinstance(result, dict) or not result.get('status') or not result.get('data'):
        # Never print whole API responses: these may contain credentials.
        code = result.get('errorcode', 'unknown') if isinstance(result, dict) else 'unknown'
        raise RuntimeError(f'{operation} failed (code {code}). Check credentials, API access and network.')
    return result['data']


def positive_minutes(value):
    try:
        minutes = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError('interval must be a number') from None
    if not 0 < minutes < float('inf'):
        raise argparse.ArgumentTypeError('interval must be a finite number greater than zero')
    return minutes


def snapshot_minutes(value):
    minutes = positive_minutes(value)
    if minutes * 60 < 1:
        raise argparse.ArgumentTypeError('print interval must be at least one second')
    return minutes


def nonnegative_integer(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('strike count must be a whole number') from None
    if number < 0:
        raise argparse.ArgumentTypeError('strike count cannot be negative')
    return number


def next_snapshot_time(now, interval_seconds):
    """Return the next wall-clock interval end, one second before its boundary."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = (now - midnight).total_seconds()
    slot = int((elapsed + 1) // interval_seconds) + 1
    return midnight + timedelta(seconds=slot * interval_seconds - 1)


def json_number(value):
    return int(value) if value == value.to_integral_value() else float(value)


def top_open_interest(latest_oi, side, count=TOP_OI_COUNT):
    ranked = ((strike, values[side]) for strike, values in latest_oi.items()
              if side in values)
    return sorted(ranked, key=lambda item: (-item[1], item[0]))[:count]


def format_oi_ranking(stamp, label, ranking):
    details = ' | '.join(
        f'{position}) {strike}: {oi:,}'
        for position, (strike, oi) in enumerate(ranking, start=1))
    return f'[{stamp:%H:%M:%S}] Top {TOP_OI_COUNT} {label} OI: {details or "N/A"}'


def dated_json_path(base_path, session_day):
    suffix = base_path.suffix or '.json'
    stem = base_path.stem if base_path.suffix else base_path.name
    return base_path.with_name(f'{stem}_{session_day:%Y-%m-%d}{suffix}')


def append_json_snapshot(path, snapshot):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        with path.open('r', encoding='utf-8') as source:
            contents = source.read()
        history = json.loads(contents) if contents.strip() else []
        if not isinstance(history, list):
            raise ValueError('JSON snapshot file must contain an array')
    else:
        history = []
    history.append(snapshot)
    temporary = path.with_name(f'.{path.name}.tmp')
    with temporary.open('w', encoding='utf-8') as output:
        json.dump(history, output, indent=2)
        output.write('\n')
    os.replace(temporary, path)


def stream(strike_pairs, atm_strike, credentials, stop, session_day, print_interval,
           strike_interval, select_live_pairs, json_file):
    import websocket

    def make_token_map(pairs):
        return {str(row['token']): (strike, row)
                for strike, pair in pairs.items() for row in pair}

    feed_lock = threading.Lock()
    feed_state = {
        'tokens': make_token_map(strike_pairs),
        'strikes': list(strike_pairs),
        'atm_strike': atm_strike,
        'latest_oi': {},
    }
    next_strike_refresh = time.monotonic() + strike_interval
    failures = 0

    def subscription_message(action, token_ids):
        return json.dumps({'correlationID': 'niftyoi001', 'action': action,
            'params': {'mode': 3, 'tokenList': [
                {'exchangeType': 2, 'tokens': token_ids}]}})

    def rotate_pair(ws):
        try:
            new_atm_strike, new_strike_pairs = select_live_pairs()
        except Exception as exc:
            print(f'ATM refresh failed ({type(exc).__name__}); will retry.', flush=True)
            return
        new_tokens = make_token_map(new_strike_pairs)
        with feed_lock:
            old_token_ids = list(feed_state['tokens'])
            if set(old_token_ids) == set(new_tokens):
                feed_state['atm_strike'] = new_atm_strike
                return
            feed_state['tokens'] = new_tokens
            feed_state['strikes'] = list(new_strike_pairs)
            feed_state['atm_strike'] = new_atm_strike
            feed_state['latest_oi'].clear()
        try:
            ws.send(subscription_message(0, old_token_ids))
            ws.send(subscription_message(1, list(new_tokens)))
        except websocket.WebSocketException:
            ws.close()

    def emit_snapshot(stamp):
        with feed_lock:
            atm = feed_state['atm_strike']
            records = []
            for strike in feed_state['strikes']:
                values = feed_state['latest_oi'].get(strike, {})
                call_oi = values.get('CE')
                put_oi = values.get('PE')
                pcr = put_oi / call_oi if put_oi is not None and call_oi else None
                records.append({
                    'strike': json_number(strike),
                    'is_atm': strike == atm,
                    'pcr': round(pcr, 2) if pcr is not None else None,
                })
            put_ranking = top_open_interest(feed_state['latest_oi'], 'PE')
            call_ranking = top_open_interest(feed_state['latest_oi'], 'CE')
            output = [
                format_oi_ranking(stamp, 'PUT', put_ranking),
                format_oi_ranking(stamp, 'CALL', call_ranking),
            ]
            snapshot = {
                'timestamp': stamp.isoformat(timespec='seconds'),
                'atm_strike': json_number(atm),
                'strikes': records,
            }
        print('\n'.join(output), flush=True)
        try:
            append_json_snapshot(json_file, snapshot)
        except Exception as exc:
            print(f'JSON snapshot write failed ({type(exc).__name__}).', flush=True)

    while not stop.is_set():
        state = {'last_tick': time.monotonic(), 'received': False, 'fatal': False}
        ended = threading.Event()

        def on_open(ws):
            with feed_lock:
                token_ids = list(feed_state['tokens'])
            ws.send(subscription_message(1, token_ids))
            print('Connected; subscription sent. Waiting for option ticks...', flush=True)

        def on_message(ws, message):
            if isinstance(message, str):
                if message.lower() == 'pong':
                    return
                try:
                    reply = json.loads(message)
                except ValueError:
                    print('Received an unrecognized server message.', flush=True)
                    return
                if isinstance(reply, dict) and (reply.get('errorCode') or reply.get('errorcode')
                        or reply.get('status') is False):
                    print('Subscription rejected. Check market-data permission and selected tokens.', flush=True)
                    state['fatal'] = True
                    ws.close()
                return
            if message == b'pong':
                return
            try:
                tick = parse_tick(message)
                if tick is None:
                    return
            except (ValueError, UnicodeError, OverflowError, OSError, struct.error):
                print('Skipped a malformed market-data packet.', flush=True)
                return
            state['last_tick'] = time.monotonic()
            state['received'] = True
            with feed_lock:
                token_data = feed_state['tokens'].get(tick['token'])
                if token_data is None:
                    return
                strike, row = token_data
                side = row['symbol'][-2:]
                if side not in ('CE', 'PE') or tick['oi'] < 0:
                    return
                feed_state['latest_oi'].setdefault(strike, {})[side] = tick['oi']

        def on_error(ws, error):
            status = getattr(error, 'status_code', None)
            if status in (401, 403):
                state['fatal'] = True
                print('WebSocket authentication rejected. Check API access and restart to log in.', flush=True)
            else:
                print(f'WebSocket error ({type(error).__name__}); connection will be retried.', flush=True)

        def on_close(ws, status, message):
            print('WebSocket disconnected.', flush=True)

        ws = websocket.WebSocketApp(WS_URL, header=credentials,
            on_open=on_open, on_message=on_message, on_error=on_error, on_close=on_close)

        def heartbeat():
            nonlocal next_strike_refresh
            last_warning = time.monotonic()
            last_ping = time.monotonic()
            check_interval = min(1.0, strike_interval)
            while not ended.wait(check_interval):
                if stop.is_set() or datetime.now(IST).date() != session_day:
                    stop.set()
                    ws.close()
                    return
                now = time.monotonic()
                connected = ws.sock and ws.sock.connected
                if connected and now - last_ping >= 10:
                    try:
                        ws.send('ping')
                    except websocket.WebSocketException:
                        ws.close()
                        return
                    last_ping = now
                if connected and now >= next_strike_refresh:
                    next_strike_refresh = now + strike_interval
                    rotate_pair(ws)
                if now - state['last_tick'] > 60 and now - last_warning > 60:
                    print('No option ticks for 60s. Market may be closed or feed unavailable.', flush=True)
                    last_warning = now

        def snapshot_worker():
            last_scheduled = None
            while not ended.is_set():
                now = datetime.now(IST)
                scheduled = next_snapshot_time(now, print_interval)
                if last_scheduled is not None and scheduled <= last_scheduled:
                    scheduled = last_scheduled + timedelta(seconds=print_interval)
                delay = max(0.0, (scheduled - now).total_seconds())
                if ended.wait(delay):
                    return
                last_scheduled = scheduled
                if stop.is_set() or datetime.now(IST).date() != session_day:
                    return
                if ws.sock and ws.sock.connected:
                    emit_snapshot(scheduled)

        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        snapshot_thread = threading.Thread(target=snapshot_worker, daemon=True)
        heartbeat_thread.start()
        snapshot_thread.start()
        try:
            # websocket-client verifies TLS certificates by default.
            # Protocol ping also detects a dead connection; text ping serves SmartAPI.
            ws.run_forever(ping_interval=20, ping_timeout=10)
        finally:
            ended.set()
            ws.close()
            heartbeat_thread.join(timeout=2)
            snapshot_thread.join(timeout=2)
        if stop.is_set():
            break
        if state['fatal']:
            raise RuntimeError('Feed stopped after an authentication/subscription rejection.')
        failures = 1 if state['received'] else failures + 1
        if failures > 5:
            raise RuntimeError('Five reconnect attempts failed. Check connectivity and restart.')
        delay = min(2 ** failures, 30)
        print(f'Reconnecting in {delay}s; current CE/PE pair will be resubscribed.', flush=True)
        stop.wait(delay)


def self_test():
    # Offline checks: expiry/ATM selection and broker binary field boundaries.
    rows = []
    for expiry in ('05OCT2026', '06OCT2026'):
        for strike in (24950, 25000, 25050, 25100):
            for side in ('CE', 'PE'):
                rows.append(dict(exch_seg='NFO', name='NIFTY', instrumenttype='OPTIDX',
                    expiry=expiry, strike=str(strike * 100), token=str(len(rows) + 1),
                    symbol=f'NIFTY{expiry}{strike}{side}'))
    before = datetime(2026, 10, 5, 12, tzinfo=IST)
    expiry, strike, pair = select_pair(rows, Decimal('25025'), before)
    assert expiry == date(2026, 10, 5) and strike == 25050 and len(pair) == 2
    expiry, strike, pairs = select_strikes(rows, Decimal('25025'), before, 1)
    assert expiry == date(2026, 10, 5) and strike == 25050
    assert list(pairs) == [Decimal('25000'), Decimal('25050'), Decimal('25100')]
    assert select_pair(rows, Decimal('25001'), before.replace(hour=16))[0] == date(2026, 10, 6)
    assert select_pair(rows, Decimal('25001'), before, date(2026, 10, 6))[1] == 25000
    try:
        select_pair([], Decimal('25000'), before)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Missing contracts were not rejected')
    scheduled_from = datetime(2026, 10, 5, 9, 15, 20, tzinfo=IST)
    assert next_snapshot_time(scheduled_from, 60) == scheduled_from.replace(second=59)
    assert next_snapshot_time(scheduled_from.replace(second=59), 60) == datetime(
        2026, 10, 5, 9, 16, 59, tzinfo=IST)
    assert next_snapshot_time(scheduled_from.replace(minute=1), 300) == datetime(
        2026, 10, 5, 9, 4, 59, tzinfo=IST)
    assert dated_json_path(Path('nifty_pcr.json'), before.date()) == Path(
        'nifty_pcr_2026-10-05.json')
    assert dated_json_path(Path('history'), before.date()) == Path(
        'history_2026-10-05.json')
    oi_sample = {
        Decimal('25000'): {'CE': 300, 'PE': 100},
        Decimal('25050'): {'CE': 100, 'PE': 200},
        Decimal('25100'): {'PE': 200},
    }
    assert top_open_interest(oi_sample, 'PE') == [
        (Decimal('25050'), 200), (Decimal('25100'), 200),
        (Decimal('25000'), 100)]
    assert top_open_interest(oi_sample, 'CE') == [
        (Decimal('25000'), 300), (Decimal('25050'), 100)]
    assert '1) 25050: 200' in format_oi_ranking(before, 'PUT',
                                                top_open_interest(oi_sample, 'PE'))
    packet = bytearray(379)
    packet[0:2] = bytes([3, 2])
    packet[2:5] = b'123'
    struct.pack_into('<q', packet, 35, 1791181800000)
    struct.pack_into('<q', packet, 43, 12345)
    struct.pack_into('<q', packet, 131, 987654)
    assert parse_tick(packet)['oi'] == 987654
    assert parse_tick(packet)['ltp'] == 123.45
    struct.pack_into('<q', packet, 131, 0)
    assert parse_tick(packet)['oi'] == 0
    assert parse_tick(packet[:100]) is None
    packet[0] = 1
    assert parse_tick(packet) is None
    print('Offline selection, OI ranking, scheduling and binary decoding checks passed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', type=Path, default=Path(__file__).resolve().with_name('.env'))
    parser.add_argument('--expiry', type=date.fromisoformat, help='YYYY-MM-DD; default: nearest unexpired expiry')
    parser.add_argument('--interval', type=snapshot_minutes, default=1.0,
                        help='aligned PCR print/JSON interval in minutes (default: 1)')
    parser.add_argument('--strike-interval', type=positive_minutes, default=1.0,
                        help='ATM strike refresh interval in minutes (default: 1)')
    parser.add_argument('--strikes-each-side', '--strikes', dest='strikes_each_side',
                        type=nonnegative_integer, default=10,
                        help='listed strikes above and below ATM to track (default: 5)')
    parser.add_argument('--json-file', type=Path,
                        default=Path(__file__).resolve().with_name('nifty_pcr.json'),
                        help='base snapshot filename; date is added automatically')
    parser.add_argument('--init-env', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.init_env:
        with args.env.open('x', encoding='utf-8') as output:
            output.write(ENV_TEMPLATE)
        args.env.chmod(0o600)
        print(f'Created {args.env}. Fill in your credentials locally.')
        return
    try:
        import requests
        import pyotp
        from dotenv import load_dotenv
        from SmartApi import SmartConnect
    except ImportError:
        raise RuntimeError('Install the dependencies listed at the top of this script.') from None
    # SDK error logs can include authentication request bodies. Keep them private.
    logging.disable(logging.CRITICAL)
    load_dotenv(args.env)
    def required(name):
        value = os.getenv(name, '').strip()
        if not value:
            raise RuntimeError(f'Set {name} in {args.env}.')
        return value
    key, client, pin = (required(k) for k in ('ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_PIN'))
    secret = os.getenv('ANGEL_TOTP_SECRET', '').strip()
    otp = pyotp.TOTP(secret).now() if secret else getpass.getpass('Current six-digit TOTP: ').strip()
    if len(otp) != 6 or not otp.isdigit():
        raise RuntimeError('TOTP must contain six digits.')
    api = SmartConnect(api_key=key, timeout=20)
    login = require_data(api.generateSession(client, pin, otp), 'Login')
    jwt, feed = login.get('jwtToken'), api.getfeedToken()
    if not jwt or not feed:
        raise RuntimeError('Login did not return the required session/feed tokens.')
    print('Logged in. Downloading instrument master...', flush=True)
    response = requests.get(MASTER_URL, timeout=(10, 60))
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list):
        raise RuntimeError('Unexpected instrument master response.')
    indices = [r for r in rows if r.get('exch_seg') == 'NSE'
               and str(r.get('symbol', '')).upper() == 'NIFTY 50']
    if len(indices) != 1:
        raise RuntimeError('Cannot uniquely resolve NIFTY 50 spot token from instrument master.')
    index = indices[0]

    def get_atm_selection():
        quote = require_data(
            api.ltpData('NSE', index['symbol'], str(index['token'])),
            'NIFTY spot quote')
        current_spot = Decimal(str(quote['ltp']))
        if not current_spot.is_finite() or current_spot <= 0:
            raise RuntimeError('Invalid NIFTY spot price.')
        current_expiry, current_strike, current_pairs = select_strikes(
            rows, current_spot, datetime.now(IST), args.strikes_each_side,
            args.expiry)
        return current_spot, current_expiry, current_strike, current_pairs

    spot, expiry, strike, strike_pairs = get_atm_selection()
    now = datetime.now(IST)
    daily_json_file = dated_json_path(args.json_file, now.date())

    def select_live_pairs():
        _, _, current_strike, current_pairs = get_atm_selection()
        return current_strike, current_pairs

    print(f'NIFTY spot: {spot} | Expiry: {expiry} | ATM strike: {strike}')
    print('Tracking strikes: ' + ', '.join(str(item) for item in strike_pairs))
    print(f'ATM refresh interval: {args.strike_interval:g} minute(s). '
          'OI_RAW = broker value without unit conversion. Ctrl+C stops.')
    print(f'PCR snapshots will be written to {daily_json_file} at aligned interval ends.')
    print('Outside market hours the spot quote may be stale and option ticks may not arrive.')
    stop = threading.Event()
    def stop_signal(*_):
        stop.set()
    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    stream(strike_pairs, strike, {'Authorization': jwt, 'x-api-key': key,
           'x-client-code': client, 'x-feed-token': feed}, stop, now.date(),
           args.interval * 60, args.strike_interval * 60, select_live_pairs,
           daily_json_file)
    print('Stopped.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nStopped.')
    except RuntimeError as exc:
        print(f'Error: {exc}')
        raise SystemExit(1)
    except FileExistsError:
        print('The environment file already exists; it has not been overwritten.')
        raise SystemExit(1)
    except Exception as exc:
        # Avoid dumping credentials from third-party exception messages.
        print(f'Error ({type(exc).__name__}). Check configuration, connectivity and API access.')
        raise SystemExit(1)
