#!/usr/bin/env python3
"""Display a live interactive chart of NIFTY PCR JSON snapshots.

Purpose
-------
This read-only viewer charts the daily JSON history written by angel_nifty_oi.py.
Run the collector and viewer in separate terminals. The viewer polls the file and
redraws only after its modification time or size changes; it never edits the JSON.
Tkinter is used for the GUI, so no charting package such as matplotlib is needed.

Quick start
-----------
Follow today's automatically dated file:

  python nifty_pcr_chart.py

Open one exact daily file:

  python nifty_pcr_chart.py --file nifty_pcr_2026-10-05.json

Open a date derived from the default base filename:

  python nifty_pcr_chart.py --date 2026-10-05

Use the same custom base path supplied to the collector:

  python nifty_pcr_chart.py --json-file data/nifty_history.json

File selection
--------------
By default, the viewer looks beside this script for:

  nifty_pcr_YYYY-MM-DD.json

The date is today's IST date and changes automatically after midnight. If the file
does not exist yet, the window stays open and waits for it. --date fixes the date
while still deriving the filename from --json-file. --file watches an exact path
and cannot be combined with --date. --json-file and --file are mutually exclusive.

Expected JSON structure
-----------------------
The root must be an array. Valid entries use the collector's format:

  {
    "timestamp": "2026-10-05T13:43:59+05:30",
    "atm_strike": 22550,
    "strikes": [
      {"strike": 22550, "is_atm": true, "pcr": 0.63}
    ]
  }

Malformed snapshots or strike records are ignored. A null PCR creates a gap rather
than a zero. Timestamps are sorted before plotting.

PCR display filtering
---------------------
The JSON file is never changed. For each minute snapshot, the viewer plots only
strike rows satisfying this strict condition by default:

  0.25 < PCR < 2.25

Values equal to either limit are excluded. Use --pcr-min and --pcr-max to change
the limits. A strike outside the range for a snapshot creates a gap in its line.
Filtering applies only to plotted points: the legend always reports the newest
recorded PCR and labels it as above or below the visible range when appropriate.

Chart behavior and controls
---------------------------
The horizontal axis is snapshot time and the vertical axis is PCR. Each strike has
its own colored line. The latest ATM line is thicker, and observations that were ATM
at their timestamp have outlined markers. The title shows the current ATM. The
legend shows each strike's newest recorded PCR and marks the current ATM; if more
than 25 strikes occur in the history, only the first 25 legend entries are shown.

Move the pointer inside the plot to activate a crosshair that snaps to the nearest
real data point. Its floating tooltip shows the exact date/time, strike, PCR, and
whether that strike was ATM for that snapshot. Moving outside the plot hides it.
The chart redraws when the window is resized.

Command-line configuration
--------------------------
--json-file PATH
    Base filename used by angel_nifty_oi.py. The selected IST date is inserted
    before the suffix. Default: nifty_pcr.json beside this script.
--file PATH
    Exact dated JSON file to watch. Mutually exclusive with --json-file.
--date YYYY-MM-DD
    Fixed trading date used with the base filename. Default: today's IST date.
    Cannot be combined with --file.
--refresh-seconds SECONDS
    File polling interval. Must be finite and greater than zero. Default: 0.5.
--pcr-min VALUE
    Exclusive lower PCR display limit. Default: 0.25.
--pcr-max VALUE
    Exclusive upper PCR display limit. Default: 2.25.
--help
    Show this documentation and the option summary.

Examples
--------
  python nifty_pcr_chart.py
  python nifty_pcr_chart.py --refresh-seconds 1
  python nifty_pcr_chart.py --pcr-min 0.75 --pcr-max 1.50
  python nifty_pcr_chart.py --date 2026-10-05
  python nifty_pcr_chart.py --file data/nifty_history_2026-10-05.json
"""

import argparse
import colorsys
from datetime import date, datetime, timedelta, timezone
import json
import math
from pathlib import Path
import tkinter as tk
from tkinter import ttk


IST = timezone(timedelta(hours=5, minutes=30))


def positive_seconds(value):
    try:
        seconds = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError('refresh interval must be a number') from None
    if not 0 < seconds < float('inf'):
        raise argparse.ArgumentTypeError('refresh interval must be finite and greater than zero')
    return seconds


def finite_float(value):
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError('PCR limit must be a number') from None
    if not math.isfinite(number):
        raise argparse.ArgumentTypeError('PCR limit must be finite')
    return number


def dated_json_path(base_path, session_day):
    suffix = base_path.suffix or '.json'
    stem = base_path.stem if base_path.suffix else base_path.name
    return base_path.with_name(f'{stem}_{session_day:%Y-%m-%d}{suffix}')


def parse_snapshots(raw):
    if not isinstance(raw, list):
        raise ValueError('JSON root must be an array')
    parsed = []
    for snapshot in raw:
        if not isinstance(snapshot, dict):
            continue
        try:
            timestamp = datetime.fromisoformat(str(snapshot['timestamp']))
            atm = float(snapshot['atm_strike'])
        except (KeyError, TypeError, ValueError):
            continue
        values = {}
        records = snapshot.get('strikes', [])
        if not isinstance(records, list):
            continue
        for record in records:
            if not isinstance(record, dict):
                continue
            try:
                strike = float(record['strike'])
                raw_pcr = record.get('pcr')
                pcr = None if raw_pcr is None else float(raw_pcr)
            except (KeyError, TypeError, ValueError):
                continue
            if math.isfinite(strike) and (pcr is None or math.isfinite(pcr)):
                values[strike] = pcr
        parsed.append({'timestamp': timestamp, 'atm': atm, 'values': values})
    parsed.sort(key=lambda item: item['timestamp'])
    return parsed


def load_snapshots(path):
    with path.open('r', encoding='utf-8') as source:
        return parse_snapshots(json.load(source))


def filter_snapshots(snapshots, pcr_min, pcr_max):
    return [{
        'timestamp': snapshot['timestamp'],
        'atm': snapshot['atm'],
        'values': {strike: pcr for strike, pcr in snapshot['values'].items()
                   if pcr is not None and pcr_min < pcr < pcr_max},
    } for snapshot in snapshots]


def format_strike(value):
    return str(int(value)) if value.is_integer() else f'{value:g}'


def line_color(index, total):
    hue = index / max(total, 1)
    red, green, blue = colorsys.hsv_to_rgb(hue, 0.72, 0.78)
    return f'#{round(red * 255):02x}{round(green * 255):02x}{round(blue * 255):02x}'


class PCRChart:
    def __init__(self, root, base_path, exact_path, fixed_date, refresh_seconds,
                 pcr_min, pcr_max):
        self.root = root
        self.base_path = base_path
        self.exact_path = exact_path
        self.fixed_date = fixed_date
        self.refresh_ms = max(100, round(refresh_seconds * 1000))
        self.pcr_min = pcr_min
        self.pcr_max = pcr_max
        self.signature = None
        self.snapshots = []
        self.current_path = None
        self.hit_points = []
        self.plot_bounds = None

        root.title('NIFTY PCR Live Chart')
        root.geometry('1280x720')
        root.minsize(800, 480)

        self.canvas = tk.Canvas(root, background='#fbfcfe', highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.status = tk.StringVar(value='Waiting for JSON data...')
        ttk.Label(root, textvariable=self.status, anchor='w').pack(fill=tk.X, padx=10, pady=(0, 6))
        self.canvas.bind('<Configure>', lambda _event: self.draw())
        self.canvas.bind('<Motion>', self.show_crosshair)
        self.canvas.bind('<Leave>', self.hide_crosshair)
        self.poll_file()

    def source_path(self):
        if self.exact_path is not None:
            return self.exact_path
        session_day = self.fixed_date or datetime.now(IST).date()
        return dated_json_path(self.base_path, session_day)

    def poll_file(self):
        path = self.source_path()
        try:
            stat = path.stat()
            signature = (path, stat.st_mtime_ns, stat.st_size)
        except FileNotFoundError:
            signature = (path, None, None)

        if signature != self.signature:
            self.signature = signature
            self.current_path = path
            if signature[1] is None:
                self.snapshots = []
                self.status.set(f'Waiting for {path}')
                self.draw()
            else:
                try:
                    snapshots = load_snapshots(path)
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    self.status.set(f'Cannot read {path}: {type(exc).__name__}')
                else:
                    # Keep raw values so the legend cannot mistake an old
                    # in-range point for the latest PCR after the current value
                    # leaves the visible range.
                    self.snapshots = snapshots
                    visible_snapshots = filter_snapshots(
                        self.snapshots, self.pcr_min, self.pcr_max)
                    latest = snapshots[-1]['timestamp'].strftime('%H:%M:%S') if snapshots else 'none'
                    point_count = sum(len(item['values']) for item in visible_snapshots)
                    self.status.set(
                        f'Watching {path}  |  {len(snapshots)} snapshots  |  '
                        f'{point_count} visible points  |  Latest: {latest}  |  '
                        f'{self.pcr_min:g} < PCR < {self.pcr_max:g}')
                    self.draw()
        self.root.after(self.refresh_ms, self.poll_file)

    def hide_crosshair(self, _event=None):
        self.canvas.delete('crosshair')
        self.canvas.delete('tooltip')
        self.canvas.configure(cursor='')

    def show_crosshair(self, event):
        self.canvas.delete('crosshair')
        self.canvas.delete('tooltip')
        if not self.plot_bounds or not self.hit_points:
            self.canvas.configure(cursor='')
            return
        left, top, right, bottom = self.plot_bounds
        if not (left <= event.x <= right and top <= event.y <= bottom):
            self.canvas.configure(cursor='')
            return

        self.canvas.configure(cursor='crosshair')
        point = min(self.hit_points,
                    key=lambda item: (item['x'] - event.x) ** 2 + (item['y'] - event.y) ** 2)
        x, y = point['x'], point['y']
        self.canvas.create_line(x, top, x, bottom, fill='#344054', dash=(4, 3),
                                width=1, tags='crosshair')
        self.canvas.create_line(left, y, right, y, fill='#344054', dash=(4, 3),
                                width=1, tags='crosshair')
        self.canvas.create_oval(x - 5, y - 5, x + 5, y + 5, fill=point['color'],
                                outline='#101828', width=2, tags='crosshair')

        timestamp = point['timestamp'].strftime('%Y-%m-%d %H:%M:%S')
        atm_text = 'Yes' if point['is_atm'] else 'No'
        label = (f'Time: {timestamp}\n'
                 f'Strike: {format_strike(point["strike"])}\n'
                 f'PCR: {point["pcr"]:.2f}\n'
                 f'ATM: {atm_text}')
        tooltip_x, tooltip_y = x + 14, y + 14
        text_id = self.canvas.create_text(
            tooltip_x + 9, tooltip_y + 7, text=label, anchor='nw',
            font=('Segoe UI', 10), fill='#101828', tags='tooltip')
        text_box = self.canvas.bbox(text_id)
        if text_box and text_box[2] + 8 > self.canvas.winfo_width():
            tooltip_x = x - (text_box[2] - text_box[0]) - 30
        if text_box and text_box[3] + 8 > self.canvas.winfo_height():
            tooltip_y = y - (text_box[3] - text_box[1]) - 30
        self.canvas.coords(text_id, tooltip_x + 9, tooltip_y + 7)
        text_box = self.canvas.bbox(text_id)
        if text_box:
            rectangle = self.canvas.create_rectangle(
                text_box[0] - 7, text_box[1] - 5, text_box[2] + 7, text_box[3] + 5,
                fill='#ffffff', outline='#344054', width=1, tags='tooltip')
            self.canvas.tag_lower(rectangle, text_id)

    def draw(self):
        canvas = self.canvas
        canvas.delete('all')
        self.hit_points = []
        self.plot_bounds = None
        width = max(canvas.winfo_width(), 1)
        height = max(canvas.winfo_height(), 1)
        left, right, top, bottom = 72, 205, 58, 72
        chart_width = max(width - left - right, 1)
        chart_height = max(height - top - bottom, 1)
        self.plot_bounds = (left, top, left + chart_width, top + chart_height)

        latest_atm = self.snapshots[-1]['atm'] if self.snapshots else None
        title = f'NIFTY PCR by Strike  |  {self.pcr_min:g} < PCR < {self.pcr_max:g}'
        if latest_atm is not None:
            title += f'  |  Current ATM: {format_strike(latest_atm)}'
        canvas.create_text(left, 24, text=title, anchor='w',
                           font=('Segoe UI', 16, 'bold'), fill='#172033')

        if not self.snapshots:
            canvas.create_text(width / 2, height / 2, text='Waiting for snapshots...',
                               font=('Segoe UI', 14), fill='#667085')
            return

        plot_snapshots = filter_snapshots(
            self.snapshots, self.pcr_min, self.pcr_max)
        strikes = sorted({strike for item in plot_snapshots for strike in item['values']})
        pcr_values = [pcr for item in plot_snapshots for pcr in item['values'].values()
                      if pcr is not None]
        if not strikes or not pcr_values:
            canvas.create_text(width / 2, height / 2, text='No PCR values available yet',
                               font=('Segoe UI', 14), fill='#667085')
            return

        y_min = 0.0
        y_max = max(1.0, max(pcr_values) * 1.1)
        count = len(plot_snapshots)

        def x_at(index):
            return left + (chart_width / 2 if count == 1 else index * chart_width / (count - 1))

        def y_at(value):
            return top + chart_height - (value - y_min) * chart_height / (y_max - y_min)

        canvas.create_rectangle(left, top, left + chart_width, top + chart_height,
                                outline='#98a2b3', width=1)
        grid_count = 5
        for step in range(grid_count + 1):
            value = y_min + (y_max - y_min) * step / grid_count
            y = y_at(value)
            canvas.create_line(left, y, left + chart_width, y, fill='#e4e7ec')
            canvas.create_text(left - 10, y, text=f'{value:.2f}', anchor='e',
                               font=('Segoe UI', 9), fill='#475467')
        canvas.create_text(20, top + chart_height / 2, text='PCR', angle=90,
                           font=('Segoe UI', 10, 'bold'), fill='#344054')

        tick_count = min(8, count)
        tick_indices = sorted({round(i * (count - 1) / max(tick_count - 1, 1))
                               for i in range(tick_count)})
        for index in tick_indices:
            x = x_at(index)
            label = plot_snapshots[index]['timestamp'].strftime('%H:%M')
            canvas.create_line(x, top + chart_height, x, top + chart_height + 5,
                               fill='#667085')
            canvas.create_text(x, top + chart_height + 10, text=label, anchor='n',
                               font=('Segoe UI', 9), fill='#475467')
        canvas.create_text(left + chart_width / 2, height - 20, text='Time (IST)',
                           font=('Segoe UI', 10, 'bold'), fill='#344054')

        colors = {strike: line_color(index, len(strikes))
                  for index, strike in enumerate(strikes)}
        for strike in strikes:
            color = colors[strike]
            segment = []
            line_width = 3 if strike == latest_atm else 1.8
            for index, snapshot in enumerate(plot_snapshots):
                pcr = snapshot['values'].get(strike)
                if pcr is None:
                    if len(segment) >= 4:
                        canvas.create_line(*segment, fill=color, width=line_width, smooth=False)
                    segment = []
                    continue
                x, y = x_at(index), y_at(pcr)
                segment.extend((x, y))
                self.hit_points.append({
                    'x': x,
                    'y': y,
                    'timestamp': snapshot['timestamp'],
                    'strike': strike,
                    'pcr': pcr,
                    'is_atm': snapshot['atm'] == strike,
                    'color': color,
                })
                if snapshot['atm'] == strike:
                    canvas.create_oval(x - 3.5, y - 3.5, x + 3.5, y + 3.5,
                                       fill=color, outline='#101828', width=1.5)
            if len(segment) >= 4:
                canvas.create_line(*segment, fill=color, width=line_width, smooth=False)
            elif len(segment) == 2:
                x, y = segment
                canvas.create_oval(x - 2, y - 2, x + 2, y + 2,
                                   fill=color, outline=color)

        legend_x = left + chart_width + 20
        canvas.create_text(legend_x, top, text='Strike / latest PCR', anchor='nw',
                           font=('Segoe UI', 10, 'bold'), fill='#344054')
        for index, strike in enumerate(strikes[:25]):
            y = top + 25 + index * 20
            color = colors[strike]
            canvas.create_line(legend_x, y + 7, legend_x + 20, y + 7,
                               fill=color, width=3 if strike == latest_atm else 2)
            latest_value = next(
                (item['values'][strike] for item in reversed(self.snapshots)
                 if strike in item['values'] and item['values'][strike] is not None),
                None)
            if latest_value is None:
                value_text = 'N/A'
            elif latest_value <= self.pcr_min:
                value_text = f'{latest_value:.2f} (below)'
            elif latest_value >= self.pcr_max:
                value_text = f'{latest_value:.2f} (above)'
            else:
                value_text = f'{latest_value:.2f}'
            atm_text = ' ATM' if strike == latest_atm else ''
            canvas.create_text(legend_x + 27, y, anchor='nw',
                               text=f'{format_strike(strike)}  {value_text}{atm_text}',
                               font=('Segoe UI', 9), fill='#344054')
        if len(strikes) > 25:
            canvas.create_text(legend_x, top + 25 + 25 * 20, anchor='nw',
                               text=f'+ {len(strikes) - 25} more strikes',
                               font=('Segoe UI', 9), fill='#667085')


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--json-file', type=Path,
                        default=Path(__file__).resolve().with_name('nifty_pcr.json'),
                        help='base JSON filename used by angel_nifty_oi.py')
    source.add_argument('--file', type=Path,
                        help='exact dated JSON file to watch')
    parser.add_argument('--date', type=date.fromisoformat,
                        help='fixed trading date (YYYY-MM-DD); default: today in IST')
    parser.add_argument('--refresh-seconds', type=positive_seconds, default=0.5,
                        help='file polling interval (default: 0.5)')
    parser.add_argument('--pcr-min', type=finite_float, default=0.25,
                        help='exclusive lower PCR display limit (default: 0.25)')
    parser.add_argument('--pcr-max', type=finite_float, default=2.25,
                        help='exclusive upper PCR display limit (default: 2.25)')
    args = parser.parse_args()
    if args.file is not None and args.date is not None:
        parser.error('--date cannot be combined with --file')
    if args.pcr_min >= args.pcr_max:
        parser.error('--pcr-min must be less than --pcr-max')

    root = tk.Tk()
    PCRChart(root, args.json_file, args.file, args.date, args.refresh_seconds,
             args.pcr_min, args.pcr_max)
    root.mainloop()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
