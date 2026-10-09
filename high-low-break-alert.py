#!/usr/bin/env python3
"""Print a console alert whenever NIFTY 50 makes a new intraday high or low.

Requirements
------------
Same dependencies and .env file as angel_nifty_oi.py:

  python -m pip install smartapi-python websocket-client pyotp python-dotenv logzero pycryptodome requests

Usage
-----
  python high-low-break-alert.py
  python high-low-break-alert.py --no-beep
  python high-low-break-alert.py --self-test

How it works
------------
The NIFTY 50 index (NSE token 99926000) is subscribed over the Angel One
SmartAPI WebSocket in Quote mode. Every tick carries the LTP together with the
exchange's own high and low of the day.

The first tick of the session seeds the day range from the exchange high/low, so
starting the script mid-day does not alert on the range already made. After
that, every tick whose LTP or exchange day high is above the tracked high prints
a NEW HIGH line (green, high-pitched beep); every tick below the tracked low
prints a NEW LOW line (red, low-pitched beep). In a strong trend this can be
many lines per minute. While sound is on, an inaudible loop keeps HDMI/
DisplayPort monitor speakers awake so they do not cut off the short tones. Set
PLAY_SOUND = False near the top of this script (or pass --no-beep) to print
alerts silently:

  [10:32:15] NEW HIGH 25,123.45 (prev 25,110.20, +13.25) | range 24,980.10 - 25,123.45
  [10:45:02] NEW LOW  24,975.30 (prev 24,980.10, -4.80) | range 24,975.30 - 25,123.45

Ticks stamped before 09:15 IST or on an earlier date (pre-open values and stale
snapshots outside market hours) are ignored. Times are the exchange tick times
in IST. WebSocket disconnects are retried with backoff; a break that happened
while disconnected is reported on the first tick after reconnecting. The
program places no orders and stops on Ctrl+C or at midnight IST.
"""

import argparse
import atexit
from datetime import date, datetime, time as clock_time, timedelta, timezone
import getpass
import io
import json
import logging
import math
import os
from pathlib import Path
import queue
import random
import signal
import struct
import sys
import tempfile
import threading
import time
import wave

# Set to False to print alerts without a beep (--no-beep also turns it off).
PLAY_SOUND = True

IST = timezone(timedelta(hours=5, minutes=30))
WS_URL = 'wss://smartapisocket.angelone.in/smart-stream'
NIFTY_TOKEN = '99926000'
NSE_CM = 1
QUOTE_MODE = 2
MARKET_OPEN = clock_time(9, 15)

# default value  HIGH_TONE, LOW_TONE, BEEP_MS -> 1500 , 600 , 250 , volume 0.5

HIGH_TONE, LOW_TONE, BEEP_MS = 1500, 600, 1000
SAMPLE_RATE, WAKE_MS = 44100, 150
GREEN, RED, RESET = '\033[92m', '\033[91m', '\033[0m'


def parse_quote(packet):
    """Read the NSE cash QUOTE fields needed here, little-endian, prices in paise."""
    if len(packet) < 123 or packet[0] != QUOTE_MODE or packet[1] != NSE_CM:
        return None
    timestamp_ms = struct.unpack_from('<q', packet, 35)[0]
    return {
        'token': packet[2:27].split(b'\0', 1)[0].decode('ascii'),
        'time': (datetime.fromtimestamp(timestamp_ms / 1000, IST) if timestamp_ms > 0
                 else datetime.now(IST)),
        'ltp': struct.unpack_from('<q', packet, 43)[0] / 100,
        'high': struct.unpack_from('<q', packet, 99)[0] / 100,
        'low': struct.unpack_from('<q', packet, 107)[0] / 100,
    }


class RangeTracker:
    """Track the day's high/low and report every break of either side."""

    def __init__(self, session_day):
        self.session_day = session_day
        self.high = None
        self.low = None

    def update(self, tick):
        """Apply a tick and return the (side, new, previous) breaks it caused.

        Returns None for ticks outside today's session. The first session tick
        only seeds the range and returns an empty list.
        """
        stamp, ltp = tick['time'], tick['ltp']
        if stamp.date() != self.session_day or stamp.time() < MARKET_OPEN or ltp <= 0:
            return None
        high = max(ltp, tick['high'])
        low = min(ltp, tick['low']) if tick['low'] > 0 else ltp
        if self.high is None:
            self.high, self.low = high, low
            return []
        breaks = []
        if high > self.high:
            breaks.append(('HIGH', high, self.high))
            self.high = high
        if low < self.low:
            breaks.append(('LOW', low, self.low))
            self.low = low
        return breaks


def format_break(stamp, side, price, previous, day_low, day_high):
    label = 'NEW HIGH' if side == 'HIGH' else 'NEW LOW '
    return (f'[{stamp:%H:%M:%S}] {label} {price:,.2f} (prev {previous:,.2f}, '
            f'{price - previous:+.2f}) | range {day_low:,.2f} - {day_high:,.2f}')


class Beeper:
    """Play alert tones off the WebSocket thread; at most one tone waits while another plays.

    HDMI/DisplayPort monitor speakers mute after a moment of silence and swallow
    short sounds, so an inaudible loop keeps the audio output awake between alerts.
    """

    def __init__(self, enabled):
        self.enabled = enabled
        self.pending = queue.Queue(maxsize=1)
        if enabled:
            threading.Thread(target=self._play, daemon=True).start()

    def beep(self, side):
        if not self.enabled:
            return
        try:
            self.pending.put_nowait(HIGH_TONE if side == 'HIGH' else LOW_TONE)
        except queue.Full:
            pass

    def _play(self):
        try:
            import winsound
        except ImportError:  # not Windows: terminal bell only
            while True:
                self.pending.get()
                print('\a', end='', flush=True)
        sounds = {tone: wav_bytes(hush(WAKE_MS) + tone_samples(tone, BEEP_MS))
                  for tone in (HIGH_TONE, LOW_TONE)}
        # Looping asynchronously needs a file; memory sounds only play synchronously.
        silence = Path(tempfile.gettempdir()) / f'nifty-alert-keep-awake-{os.getpid()}.wav'
        silence.write_bytes(wav_bytes(hush(1000)))
        atexit.register(stop_sound, winsound, silence)
        loop = (winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP
                | winsound.SND_NODEFAULT)

        def keep_awake():
            try:
                winsound.PlaySound(str(silence), loop)
            except RuntimeError:
                pass

        keep_awake()
        while True:
            tone = self.pending.get()
            try:
                # winsound.Beep is silent on many PCs; PlaySound uses the normal audio output.
                winsound.PlaySound(sounds[tone], winsound.SND_MEMORY | winsound.SND_NODEFAULT)
            except RuntimeError:
                print('\a', end='', flush=True)
            keep_awake()


def stop_sound(winsound, silence):
    try:
        winsound.PlaySound(None, 0)
        silence.unlink(missing_ok=True)
    except (RuntimeError, OSError):
        pass


def hush(milliseconds):
    """Inaudible +-2 LSB noise; unlike digital silence it keeps HDMI/DisplayPort audio awake."""
    return [random.randint(-2, 2) for _ in range(SAMPLE_RATE * milliseconds // 1000)]


def tone_samples(frequency, milliseconds, volume=0.5):
    """Sine tone with 10 ms fades to avoid clicks."""
    count = SAMPLE_RATE * milliseconds // 1000
    fade = SAMPLE_RATE // 100
    return [int(32767 * volume * min(1.0, i / fade, (count - i) / fade)
                * math.sin(2 * math.pi * frequency * i / SAMPLE_RATE)) for i in range(count)]


def wav_bytes(samples):
    """Pack 16-bit mono samples into an in-memory WAV file."""
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(struct.pack(f'<{len(samples)}h', *samples))
    return output.getvalue()


def enable_color():
    if not sys.stdout.isatty():
        return False
    if os.name == 'nt':
        os.system('')  # switches the Windows console into ANSI escape mode
    return True


def require_data(result, operation):
    if not isinstance(result, dict) or not result.get('status') or not result.get('data'):
        # Never print whole API responses: these may contain credentials.
        code = result.get('errorcode', 'unknown') if isinstance(result, dict) else 'unknown'
        raise RuntimeError(f'{operation} failed (code {code}). Check credentials, API access and network.')
    return result['data']


def stream(credentials, stop, session_day, beeper, color):
    import websocket

    tracker = RangeTracker(session_day)
    subscription = json.dumps({'correlationID': 'niftyhl001', 'action': 1,
        'params': {'mode': QUOTE_MODE, 'tokenList': [
            {'exchangeType': NSE_CM, 'tokens': [NIFTY_TOKEN]}]}})
    notices = {'waiting': False}
    failures = 0

    def report(tick):
        seeded = tracker.high is not None
        breaks = tracker.update(tick)
        stamp = tick['time']
        if breaks is None:
            if not notices['waiting']:
                print(f'Ignoring ticks before {MARKET_OPEN:%H:%M} IST today '
                      '(pre-open or stale data). Alerts start once the session is live.', flush=True)
                notices['waiting'] = True
            return
        if not seeded:
            print(f'[{stamp:%H:%M:%S}] Day range so far: {tracker.low:,.2f} - {tracker.high:,.2f}'
                  f' | LTP {tick["ltp"]:,.2f}. Watching for breaks...', flush=True)
        for side, price, previous in breaks:
            line = format_break(stamp, side, price, previous, tracker.low, tracker.high)
            if color:
                line = (GREEN if side == 'HIGH' else RED) + line + RESET
            print(line, flush=True)
            beeper.beep(side)

    while not stop.is_set():
        state = {'last_tick': time.monotonic(), 'received': False, 'fatal': False}
        ended = threading.Event()

        def on_open(ws):
            ws.send(subscription)
            print('Connected; subscribed to NIFTY 50. Waiting for ticks...', flush=True)

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
                    print('Subscription rejected. Check market-data permission.', flush=True)
                    state['fatal'] = True
                    ws.close()
                return
            if message == b'pong':
                return
            try:
                tick = parse_quote(message)
            except (ValueError, UnicodeError, OverflowError, OSError, struct.error):
                print('Skipped a malformed market-data packet.', flush=True)
                return
            if tick is None or tick['token'] != NIFTY_TOKEN:
                return
            state['last_tick'] = time.monotonic()
            state['received'] = True
            report(tick)

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
            last_ping = time.monotonic()
            warned = False
            while not ended.wait(1):
                if stop.is_set() or datetime.now(IST).date() != session_day:
                    stop.set()
                    ws.close()
                    return
                now = time.monotonic()
                if ws.sock and ws.sock.connected and now - last_ping >= 10:
                    try:
                        ws.send('ping')
                    except websocket.WebSocketException:
                        ws.close()
                        return
                    last_ping = now
                stale = now - state['last_tick'] > 60
                if stale and not warned:
                    print('No NIFTY ticks for 60s. Market may be closed or feed unavailable.', flush=True)
                warned = stale

        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        heartbeat_thread.start()
        try:
            # websocket-client verifies TLS certificates by default.
            # Protocol ping also detects a dead connection; text ping serves SmartAPI.
            ws.run_forever(ping_interval=20, ping_timeout=10)
        finally:
            ended.set()
            ws.close()
            heartbeat_thread.join(timeout=2)
        if stop.is_set():
            break
        if state['fatal']:
            raise RuntimeError('Feed stopped after an authentication/subscription rejection.')
        failures = 1 if state['received'] else failures + 1
        if failures > 5:
            raise RuntimeError('Five reconnect attempts failed. Check connectivity and restart.')
        delay = min(2 ** failures, 30)
        print(f'Reconnecting in {delay}s; tracked high/low is kept.', flush=True)
        stop.wait(delay)


def self_test():
    # Offline checks: binary field offsets, session filtering and break detection.
    def tick(clock, ltp, high, low, day=date(2026, 10, 8)):
        stamp = datetime.combine(day, clock, IST)
        return {'token': NIFTY_TOKEN, 'time': stamp, 'ltp': ltp, 'high': high, 'low': low}

    packet = bytearray(123)
    packet[0:2] = bytes([QUOTE_MODE, NSE_CM])
    packet[2:10] = NIFTY_TOKEN.encode('ascii')
    struct.pack_into('<q', packet, 35, 1791435600000)
    struct.pack_into('<q', packet, 43, 2512345)
    struct.pack_into('<q', packet, 99, 2515000)
    struct.pack_into('<q', packet, 107, 2498010)
    parsed = parse_quote(packet)
    assert parsed['token'] == NIFTY_TOKEN
    assert parsed['time'] == datetime(2026, 10, 8, 10, 30, tzinfo=IST)
    assert (parsed['ltp'], parsed['high'], parsed['low']) == (25123.45, 25150.0, 24980.1)
    assert parse_quote(packet[:100]) is None
    packet[0] = 3
    assert parse_quote(packet) is None

    tracker = RangeTracker(date(2026, 10, 8))
    assert tracker.update(tick(clock_time(9, 10), 25000, 25000, 25000)) is None
    assert tracker.update(tick(clock_time(10), 25000, 25100, 24900, date(2026, 10, 7))) is None
    assert tracker.update(tick(clock_time(11), 25050, 25100, 24900)) == []
    assert (tracker.low, tracker.high) == (24900, 25100)
    assert tracker.update(tick(clock_time(11, 0, 1), 25100, 25100, 24900)) == []
    assert tracker.update(tick(clock_time(11, 0, 2), 25100.05, 25100.05, 24900)) == [
        ('HIGH', 25100.05, 25100)]
    assert tracker.update(tick(clock_time(11, 0, 3), 25090, 25120, 24900)) == [
        ('HIGH', 25120, 25100.05)]
    assert tracker.update(tick(clock_time(11, 0, 4), 24899.95, 25120, 24899.95)) == [
        ('LOW', 24899.95, 24900)]
    assert tracker.update(tick(clock_time(11, 0, 5), 24950, 25120, 0)) == []
    assert (tracker.low, tracker.high) == (24899.95, 25120)

    line = format_break(datetime(2026, 10, 8, 10, 32, 15, tzinfo=IST), 'HIGH',
                        25123.45, 25110.20, 24980.10, 25123.45)
    assert line == ('[10:32:15] NEW HIGH 25,123.45 (prev 25,110.20, +13.25) '
                    '| range 24,980.10 - 25,123.45'), line
    quiet = hush(WAKE_MS)
    assert max(map(abs, quiet)) <= 2
    with wave.open(io.BytesIO(wav_bytes(quiet + tone_samples(HIGH_TONE, BEEP_MS)))) as audio:
        assert audio.getframerate() == SAMPLE_RATE
        assert audio.getnframes() == SAMPLE_RATE * (WAKE_MS + BEEP_MS) // 1000
    print('Offline decoding, session filtering, break detection and tone checks passed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', type=Path, default=Path(__file__).resolve().with_name('.env'))
    parser.add_argument('--no-beep', action='store_true', help='print alerts without a sound')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    try:
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
    print('Logged in. Alerting on every new NIFTY 50 intraday high/low. Ctrl+C stops.', flush=True)
    stop = threading.Event()
    def stop_signal(*_):
        stop.set()
    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    stream({'Authorization': jwt, 'x-api-key': key, 'x-client-code': client,
            'x-feed-token': feed}, stop, datetime.now(IST).date(),
           Beeper(PLAY_SOUND and not args.no_beep), enable_color())
    print('Stopped.')


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
