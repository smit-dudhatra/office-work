#!/usr/bin/env python3
"""Play the NEW HIGH / NEW LOW beeps of high-low-break-alert.py without the market feed.

Usage
-----
  python alert-tone-simulator.py
  python alert-tone-simulator.py --high 2000 --low 400 --ms 400 --volume 0.8
  python alert-tone-simulator.py --db -6

--db sets the volume in decibels below full scale (dBFS): 0 dB is volume 1,
-6 dB is about volume 0.5 and -20 dB is volume 0.1. It is relative to the
loudest beep the file can hold; how loud that is in the room still depends on
the Windows volume and the speakers.

The beeps are made the same way as in high-low-break-alert.py: a sine tone
with 10 ms fades, an inaudible 150 ms lead-in and an inaudible loop that keeps
HDMI/DisplayPort monitor speakers awake between beeps. HIGH_TONE, LOW_TONE,
BEEP_MS and VOLUME below start as copies of that script's values. Change them
here, or pass the options above, to try other beeps; the alert script itself
is not changed.

It plays both beeps once at start, then asks:

  h            NEW HIGH beep
  l            NEW LOW beep
  b or Enter   both, high then low
  1200         any tone: 1200 Hz for the current beep length
  1200 400     1200 Hz for 400 ms
  q            quit
"""

import argparse
import io
import math
import os
from pathlib import Path
import random
import struct
import sys
import tempfile
import time
import wave

try:
    import winsound
except ImportError:
    sys.exit('This script plays sounds through winsound and only runs on Windows.')

# Copied from high-low-break-alert.py (VOLUME is its tone_samples default).
HIGH_TONE, LOW_TONE, BEEP_MS = 4000, 3999, 1000
VOLUME = 1
SAMPLE_RATE, WAKE_MS = 44100, 150
GREEN, RED, RESET = '\033[92m', '\033[91m', '\033[0m'
GAP_SECONDS = 0.5  # pause between the high and low beep when playing both
MIN_HZ, MAX_HZ, MIN_MS, MAX_MS = 20, 20000, 20, 5000
MIN_DB = -60  # volume 0.001, barely audible


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


class Player:
    """Play beeps from memory like the alert script's Beeper, with the keep-awake loop in between."""

    def __init__(self):
        # Looping asynchronously needs a file; memory sounds only play synchronously.
        self.silence = Path(tempfile.gettempdir()) / f'alert-tone-simulator-keep-awake-{os.getpid()}.wav'
        self.silence.write_bytes(wav_bytes(hush(1000)))
        self.keep_awake()

    def keep_awake(self):
        try:
            winsound.PlaySound(str(self.silence), winsound.SND_FILENAME | winsound.SND_ASYNC
                               | winsound.SND_LOOP | winsound.SND_NODEFAULT)
        except RuntimeError:
            pass

    def play(self, frequency, milliseconds, volume):
        sound = wav_bytes(hush(WAKE_MS) + tone_samples(frequency, milliseconds, volume))
        try:
            winsound.PlaySound(sound, winsound.SND_MEMORY | winsound.SND_NODEFAULT)
        except RuntimeError:
            print('\a', end='', flush=True)
        self.keep_awake()

    def close(self):
        try:
            winsound.PlaySound(None, 0)
            self.silence.unlink(missing_ok=True)
        except (RuntimeError, OSError):
            pass


def main():
    parser = argparse.ArgumentParser(description='Play the NEW HIGH / NEW LOW alert beeps.')
    parser.add_argument('--high', type=int, default=HIGH_TONE, help=f'NEW HIGH tone in Hz (default {HIGH_TONE})')
    parser.add_argument('--low', type=int, default=LOW_TONE, help=f'NEW LOW tone in Hz (default {LOW_TONE})')
    parser.add_argument('--ms', type=int, default=BEEP_MS, help=f'beep length in ms (default {BEEP_MS})')
    loudness = parser.add_mutually_exclusive_group()
    loudness.add_argument('--volume', type=float, default=VOLUME, help=f'0 to 1 (default {VOLUME})')
    loudness.add_argument('--db', type=float, help=f'volume in dB, {MIN_DB} to 0 (0 = volume 1)')
    args = parser.parse_args()
    if args.db is not None:
        if not MIN_DB <= args.db <= 0:
            parser.error(f'--db must be between {MIN_DB} and 0')
        args.volume = 10 ** (args.db / 20)
    for tone in (args.high, args.low):
        if not MIN_HZ <= tone <= MAX_HZ:
            parser.error(f'tones must be between {MIN_HZ} and {MAX_HZ} Hz')
    if not MIN_MS <= args.ms <= MAX_MS:
        parser.error(f'--ms must be between {MIN_MS} and {MAX_MS}')
    if not 0 < args.volume <= 1:
        parser.error('--volume must be above 0 and at most 1')

    color = enable_color()

    def beep(label, frequency, milliseconds, paint=''):
        text = (f'{label}  {frequency} Hz, {milliseconds} ms, '
                f'volume {args.volume:.3g} ({20 * math.log10(args.volume):.1f} dB)')
        print(f'{paint}{text}{RESET}' if color and paint else text, flush=True)
        player.play(frequency, milliseconds, args.volume)

    def both():
        beep('NEW HIGH', args.high, args.ms, GREEN)
        time.sleep(GAP_SECONDS)
        beep('NEW LOW ', args.low, args.ms, RED)

    player = Player()
    try:
        both()
        while True:
            words = input('\nh = high, l = low, b/Enter = both, <Hz> [ms] = any tone, q = quit: ').lower().split()
            numbers = [int(word) for word in words if word.isdigit()]
            if words in ([], ['b']):
                both()
            elif words == ['h']:
                beep('NEW HIGH', args.high, args.ms, GREEN)
            elif words == ['l']:
                beep('NEW LOW ', args.low, args.ms, RED)
            elif words == ['q']:
                break
            elif (len(numbers) == len(words) <= 2 and MIN_HZ <= numbers[0] <= MAX_HZ
                  and MIN_MS <= (numbers[1:] or [args.ms])[0] <= MAX_MS):
                beep('TONE    ', numbers[0], (numbers[1:] or [args.ms])[0])
            else:
                print(f'Type h, l, b, q, or a tone of {MIN_HZ}-{MAX_HZ} Hz with an '
                      f'optional length of {MIN_MS}-{MAX_MS} ms, e.g. "1200" or "1200 400".')
    except (EOFError, KeyboardInterrupt):
        print()
    finally:
        player.close()


if __name__ == '__main__':
    main()
