#!/usr/bin/env python3
"""List the sounds that come with Windows and play one by its number.

Usage
-----
  python windows-sound-picker.py            show the numbered list, then pick
  python windows-sound-picker.py 12         play sound 12 and exit
  python windows-sound-picker.py --all      play every sound in order and exit
  python windows-sound-picker.py --list     only print the numbered list

At the prompt, type a number to play that sound, "a" to play them all in order
("a 30" starts from sound 30), "l" to show the list again and "q" to quit.
Ctrl+C stops the sound that is playing. The full path of each played sound is
printed so it can be reused in another script.

The sounds are the .wav files under C:\\Windows\\Media. Like
high-low-break-alert.py, an inaudible loop keeps HDMI/DisplayPort monitor
speakers awake so the start of short sounds is not cut off.
"""

import argparse
import io
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
    sys.exit('This script plays Windows system sounds and only runs on Windows.')

MEDIA = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'Media'
WAKE_MS = 150      # inaudible lead-in so monitor speakers are awake when the sound starts
GAP_SECONDS = 0.7  # pause between sounds when playing them all


def find_sounds():
    """Return (name, path, seconds) for every PCM .wav under MEDIA; subfolders sort last."""
    sounds = []
    for path in MEDIA.rglob('*.wav'):
        try:
            with wave.open(str(path)) as audio:
                seconds = audio.getnframes() / audio.getframerate()
        except (wave.Error, EOFError, OSError):
            continue  # compressed or unreadable; winsound plays PCM only
        sounds.append((str(path.relative_to(MEDIA).with_suffix('')), path, seconds))
    return sorted(sounds, key=lambda sound: (os.sep in sound[0], sound[0].lower()))


def hush(seconds, channels, rate):
    """Inaudible +-2 LSB 16-bit noise; unlike digital silence it keeps HDMI/DisplayPort audio awake."""
    count = int(rate * seconds) * channels
    return struct.pack(f'<{count}h', *(random.randint(-2, 2) for _ in range(count)))


def with_lead_in(path):
    """Return the sound as WAV bytes with WAKE_MS of hush in front."""
    with wave.open(str(path)) as audio:
        params = audio.getparams()
        frames = audio.readframes(params.nframes)
    if params.sampwidth == 2:
        frames = hush(WAKE_MS / 1000, params.nchannels, params.framerate) + frames
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setparams(params)
        audio.writeframes(frames)
    return output.getvalue()


class Player:
    """Play sounds asynchronously so Ctrl+C can stop them; a silent loop runs in between."""

    def __init__(self):
        # Async playback needs files; memory sounds only play synchronously.
        self.folder = tempfile.TemporaryDirectory(prefix='windows-sound-picker-',
                                                  ignore_cleanup_errors=True)
        self.silence = Path(self.folder.name) / 'keep-awake.wav'
        with wave.open(str(self.silence), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(44100)
            audio.writeframes(hush(1, 1, 44100))
        self.keep_awake()

    def keep_awake(self):
        winsound.PlaySound(str(self.silence), winsound.SND_FILENAME | winsound.SND_ASYNC
                           | winsound.SND_LOOP | winsound.SND_NODEFAULT)

    def play(self, number, path, seconds):
        copy = Path(self.folder.name) / f'{number}.wav'
        if not copy.exists():
            copy.write_bytes(with_lead_in(path))
        winsound.PlaySound(str(copy), winsound.SND_FILENAME | winsound.SND_ASYNC
                           | winsound.SND_NODEFAULT)
        try:
            time.sleep(WAKE_MS / 1000 + seconds)
        finally:
            self.keep_awake()  # also cuts the sound short after Ctrl+C

    def close(self):
        winsound.PlaySound(None, 0)
        self.folder.cleanup()


def print_list(sounds):
    width = len(str(len(sounds)))
    for number, (name, _, seconds) in enumerate(sounds, 1):
        print(f'{number:>{width}}. {name:<36} {seconds:5.1f} s')


def play_one(player, sounds, number):
    name, path, seconds = sounds[number - 1]
    print(f'Playing {number}. {name}  ({path})', flush=True)
    try:
        player.play(number, path, seconds)
    except KeyboardInterrupt:
        print('Stopped.')


def play_all(player, sounds, start=1):
    try:
        for number in range(start, len(sounds) + 1):
            name, path, seconds = sounds[number - 1]
            print(f'{number:>2}/{len(sounds)}  {name}', flush=True)
            player.play(number, path, seconds)
            time.sleep(GAP_SECONDS)
    except KeyboardInterrupt:
        print(f'Stopped at {number}. Type "a {number}" to carry on from there.')


def pick(player, sounds):
    print_list(sounds)
    prompt = f'\nSound number (1-{len(sounds)}), a = play all, l = list, q = quit: '
    while True:
        try:
            words = input(prompt).strip().lower().split()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not words:
            continue
        valid = [word.isdigit() and 1 <= int(word) <= len(sounds) for word in words[1:]]
        if words[0] in ('q', 'quit', 'exit') and len(words) == 1:
            return
        if words[0] in ('l', 'list') and len(words) == 1:
            print_list(sounds)
        elif words[0] in ('a', 'all') and len(words) <= 2 and all(valid):
            play_all(player, sounds, int(words[1]) if len(words) == 2 else 1)
        elif len(words) == 1 and words[0].isdigit() and 1 <= int(words[0]) <= len(sounds):
            play_one(player, sounds, int(words[0]))
        else:
            print(f'Type a number from 1 to {len(sounds)}, a, a <number>, l or q.')


def main():
    parser = argparse.ArgumentParser(description='List the Windows system sounds and play one by number.')
    parser.add_argument('number', nargs='?', type=int, help='play this sound and exit')
    parser.add_argument('--all', action='store_true', help='play every sound in order and exit')
    parser.add_argument('--list', action='store_true', help='print the numbered list and exit')
    args = parser.parse_args()

    sounds = find_sounds()
    if not sounds:
        sys.exit(f'No .wav sounds found in {MEDIA}.')
    if args.number is not None and not 1 <= args.number <= len(sounds):
        parser.error(f'number must be between 1 and {len(sounds)}')
    if args.list:
        print_list(sounds)
        return

    player = Player()
    try:
        if args.number is not None:
            play_one(player, sounds, args.number)
        elif args.all:
            play_all(player, sounds)
        else:
            pick(player, sounds)
    finally:
        player.close()


if __name__ == '__main__':
    main()
