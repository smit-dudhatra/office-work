#!/usr/bin/env python3
"""Show the live NIFTY 50 index price from the Upstox market-data WebSocket (V3).

Requirements
------------
  python -m pip install upstox-python-sdk websocket-client python-dotenv

Put an Upstox token in the .env file next to this script:

  UPSTOX_ACCESS_TOKEN=<token>

Either a daily access token (expires around 3:30 AM IST) or the 1-year
read-only Analytics Token from the Upstox Developer Apps page works.

Usage
-----
  python upstox-webscoket.py
  python upstox-webscoket.py --self-test

How it works
------------
NSE_INDEX|Nifty 50 is subscribed in "full" mode on the Upstox V3 market-data
feed. Frames arrive as protobuf and are decoded with the schema shipped in
upstox-python-sdk. In a terminal, one line is redrawn on every tick, with an
up/down arrow and green/red colour against the previous close:

  NIFTY 50  25,184.35  +112.40 (+0.45%)  O 25,090.10  H 25,201.75  L 25,061.40  14:21:07

Change is against the previous close, O/H/L are the day's open/high/low, and
the time is the exchange tick time in IST. When output is redirected, every
tick prints on its own line. Outside market hours the last snapshot is shown.

The SDK's own streamer turns off TLS certificate checks, so the connection is
made here with websocket-client, which verifies certificates by default.
Disconnects are retried with backoff. The program places no orders and stops
on Ctrl+C.
"""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import threading
import time
import uuid

try:
    from dotenv import load_dotenv
    from google.protobuf.message import DecodeError
    from upstox_client.feeder.proto.MarketDataFeedV3_pb2 import FeedResponse, MarketStatus
    import websocket
except ImportError:
    raise SystemExit('Install the dependencies listed at the top of this script.')

IST = timezone(timedelta(hours=5, minutes=30))
WS_URL = 'wss://api.upstox.com/v3/feed/market-data-feed'
NIFTY_KEY = 'NSE_INDEX|Nifty 50'
SEGMENT = 'NSE_INDEX'
GREEN, RED, RESET = '\033[92m', '\033[91m', '\033[0m'


def parse_feed(message):
    """Decode one binary feed frame into (NSE_INDEX market status, NIFTY tick); either may be None."""
    response = FeedResponse.FromString(message)
    status = None
    if response.HasField('marketInfo') and SEGMENT in response.marketInfo.segmentStatus:
        status = MarketStatus.Name(response.marketInfo.segmentStatus[SEGMENT])
    feed = response.feeds.get(NIFTY_KEY)
    if feed is None:
        return status, None
    index = feed.fullFeed.indexFF
    ltpc = index.ltpc if feed.fullFeed.HasField('indexFF') else feed.ltpc
    if ltpc.ltp <= 0:
        return status, None
    day = next((bar for bar in index.marketOHLC.ohlc if bar.interval == '1d'), None)
    return status, {
        'time': (datetime.fromtimestamp(ltpc.ltt / 1000, IST) if ltpc.ltt > 0
                 else datetime.now(IST)),
        'ltp': ltpc.ltp,
        'close': ltpc.cp,
        'day': (day.open, day.high, day.low) if day else None,
    }


def format_price(tick, arrow=False):
    parts = [f'NIFTY 50  {tick["ltp"]:,.2f}']
    if tick['close'] > 0:
        change = tick['ltp'] - tick['close']
        sign = ('▲ ' if change >= 0 else '▼ ') if arrow else ''
        parts.append(f'{sign}{change:+,.2f} ({change / tick["close"]:+.2%})')
    if tick['day']:
        parts.append('O {:,.2f}  H {:,.2f}  L {:,.2f}'.format(*tick['day']))
    parts.append(f'{tick["time"]:%H:%M:%S}')
    return '  '.join(parts)


class Display:
    """Redraw one price line in a terminal; print one line per tick when redirected."""

    def __init__(self, live):
        self.live = live
        self.drawn = False
        self.lock = threading.Lock()

    def price(self, tick):
        with self.lock:
            if not self.live:
                print(format_price(tick), flush=True)
                return
            # A line wider than the terminal wraps, and \r would then only redraw its last row.
            line = format_price(tick, arrow=True)[:shutil.get_terminal_size().columns - 1]
            if tick['close'] > 0:
                line = (GREEN if tick['ltp'] >= tick['close'] else RED) + line + RESET
            print(f'\r{line}\033[K', end='', flush=True)
            self.drawn = True

    def note(self, message):
        with self.lock:
            if self.drawn:
                print()
                self.drawn = False
            print(message, flush=True)


def enable_live_line():
    if not sys.stdout.isatty():
        return False
    if os.name == 'nt':
        os.system('')  # switches the Windows console into ANSI escape mode
    return True


def stream(token, stop, display):
    # Upstox only accepts subscription requests as binary frames.
    subscription = json.dumps({'guid': str(uuid.uuid4()), 'method': 'sub',
        'data': {'mode': 'full', 'instrumentKeys': [NIFTY_KEY]}}).encode()
    failures = 0

    while not stop.is_set():
        state = {'last_tick': time.monotonic(), 'received': False, 'fatal': None}
        ended = threading.Event()

        def on_open(ws):
            ws.send(subscription, opcode=websocket.ABNF.OPCODE_BINARY)
            display.note('Connected; subscribed to NIFTY 50. Waiting for ticks...')

        def on_message(ws, message):
            if isinstance(message, str):
                display.note(f'Server message: {message[:200]}')
                return
            try:
                status, tick = parse_feed(message)
            except DecodeError:
                display.note('Skipped a malformed market-data packet.')
                return
            if status:
                display.note(f'{SEGMENT} market status: {status}')
            if tick:
                state['last_tick'] = time.monotonic()
                state['received'] = True
                display.price(tick)

        def on_error(ws, error):
            status = getattr(error, 'status_code', None)
            if status in (401, 403):
                state['fatal'] = status
            else:
                display.note(f'WebSocket error ({type(error).__name__}); connection will be retried.')

        def on_close(ws, status, message):
            display.note('WebSocket disconnected.')

        ws = websocket.WebSocketApp(WS_URL, header={'Authorization': f'Bearer {token}'},
            on_open=on_open, on_message=on_message, on_error=on_error, on_close=on_close)

        def watch():
            warned = False
            while not ended.wait(1):
                if stop.is_set():
                    ws.close()
                    return
                stale = time.monotonic() - state['last_tick'] > 60
                if stale and not warned:
                    display.note('No NIFTY ticks for 60s. Market may be closed or the feed is idle.')
                warned = stale

        watch_thread = threading.Thread(target=watch, daemon=True)
        watch_thread.start()
        try:
            # websocket-client verifies TLS certificates by default.
            ws.run_forever(ping_interval=20, ping_timeout=10)
        finally:
            ended.set()
            ws.close()
            watch_thread.join(timeout=2)
        if stop.is_set():
            break
        if state['fatal']:
            raise RuntimeError(f'Upstox rejected the token (HTTP {state["fatal"]}). Daily access '
                               'tokens expire around 3:30 AM IST; update UPSTOX_ACCESS_TOKEN.')
        failures = 1 if state['received'] else failures + 1
        if failures > 5:
            raise RuntimeError('Five reconnect attempts failed. Check connectivity and restart.')
        delay = min(2 ** failures, 30)
        display.note(f'Reconnecting in {delay}s...')
        stop.wait(delay)


def self_test():
    # Offline checks: protobuf decoding and price-line formatting.
    stamp = datetime(2026, 10, 15, 14, 21, 7, tzinfo=IST)
    response = FeedResponse()
    response.marketInfo.segmentStatus[SEGMENT] = MarketStatus.Value('NORMAL_OPEN')
    index = response.feeds[NIFTY_KEY].fullFeed.indexFF
    index.ltpc.ltp, index.ltpc.cp = 25184.35, 25071.95
    index.ltpc.ltt = int(stamp.timestamp() * 1000)
    index.marketOHLC.ohlc.add(interval='I1', open=25180, high=25190, low=25170, close=25184.35)
    index.marketOHLC.ohlc.add(interval='1d', open=25090.10, high=25201.75, low=25061.40,
                              close=25184.35)
    status, tick = parse_feed(response.SerializeToString())
    assert status == 'NORMAL_OPEN'
    assert tick['time'] == stamp
    assert (tick['ltp'], tick['close']) == (25184.35, 25071.95)
    assert tick['day'] == (25090.10, 25201.75, 25061.40)
    line = format_price(tick, arrow=True)
    assert line == ('NIFTY 50  25,184.35  ▲ +112.40 (+0.45%)  O 25,090.10  H 25,201.75  '
                    'L 25,061.40  14:21:07'), line
    assert format_price(dict(tick, ltp=25000.5)).startswith('NIFTY 50  25,000.50  -71.45 (-0.28%)  O ')

    ltpc_only = FeedResponse()
    ltpc_only.feeds[NIFTY_KEY].ltpc.ltp = 25000
    status, tick = parse_feed(ltpc_only.SerializeToString())
    assert status is None and tick['day'] is None and tick['close'] == 0
    assert format_price(tick).startswith('NIFTY 50  25,000.00  ')

    other = FeedResponse()
    other.feeds['NSE_INDEX|Nifty Bank'].ltpc.ltp = 56000
    assert parse_feed(other.SerializeToString()) == (None, None)
    try:
        parse_feed(b'\x0a\x05ab')
    except DecodeError:
        pass
    else:
        raise AssertionError('truncated frame was not rejected')
    print('Offline decoding and formatting checks passed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', type=Path, default=Path(__file__).resolve().with_name('.env'))
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    load_dotenv(args.env)
    token = os.getenv('UPSTOX_ACCESS_TOKEN', '').strip()
    if not token:
        raise RuntimeError(f'Set UPSTOX_ACCESS_TOKEN in {args.env}.')
    display = Display(enable_live_line())
    display.note('Streaming NIFTY 50 from Upstox. Ctrl+C stops.')
    stop = threading.Event()
    def stop_signal(*_):
        stop.set()
    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    stream(token, stop, display)
    display.note('Stopped.')


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
