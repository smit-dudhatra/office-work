import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import { DEMO_SYMBOLS, type DemoSymbol } from './symbols';

/**
 * An offline market-data provider that invents realistic-looking candles.
 *
 * - One live price per symbol ticks every TICK_MS; every timeframe's forming bar
 *   follows it, so 1m / 1h / D charts of the same symbol agree on the last price.
 * - History is generated BACKWARD from that live price on first request (seeded
 *   per symbol + timeframe), and extended further back as the chart scrolls left.
 * - A slow trend state and a volatility state give the walk momentum and quiet /
 *   busy stretches instead of uniform noise.
 *
 * Everything lives in memory for the page session; a reload starts fresh.
 */

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MINUTES_PER_YEAR = 525_600;
const MINUTES_PER_MONTH = MINUTES_PER_YEAR / 12;
const TICK_MS = 250;
const INITIAL_BARS = 2_000;
const MAX_BARS = 100_000;
const MAX_GAP_FILL = 5_000;
const EARLIEST = Date.UTC(2000, 0, 1);
/** Unix epoch is a Thursday; shifting by 4 days lands week buckets on Mondays. */
const MONDAY_OFFSET = 4 * DAY;
const IST_OFFSET = 5.5 * HOUR;

const SUPPORTED_TIMEFRAMES = ['1S', '5S', '15S', '1', '3', '5', '15', '30', '60', '120', '240', 'D', 'W', 'M'];

// ── timeframes ──────────────────────────────────────────────────────────

type Timeframe =
    | { kind: 'fixed'; ms: number; offset: number; minutes: number }
    | { kind: 'month'; months: number; minutes: number };

function fixed(ms: number, offset = 0): Timeframe {
    return { kind: 'fixed', ms, offset, minutes: ms / MIN };
}

function months(n: number): Timeframe {
    return { kind: 'month', months: n, minutes: n * MINUTES_PER_MONTH };
}

/**
 * Accepts Vela's spellings: bare minutes (`'5'`, `'60'`, `'1440'`), `S/H/D/W/M/Y`
 * suffixes, and lowercase `m` for minutes. Intraday buckets align to the
 * exchange's clock (`localOffset`) so hourly bars start on the local hour.
 */
function parseTimeframe(raw: string, localOffset: number): Timeframe | null {
    const m = /^(\d*)\s*([a-zA-Z]?)$/.exec(raw.trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    const n = m[1] === '' ? 1 : parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1) return null;
    const intraday = (ms: number) => fixed(ms, -localOffset);
    switch (m[2]) {
        case '':
        case 'm':
            if (n % 43_200 === 0) return months(n / 43_200);
            if (n % 10_080 === 0) return fixed((n / 10_080) * WEEK, MONDAY_OFFSET);
            if (n % 1_440 === 0) return fixed((n / 1_440) * DAY);
            return intraday(n * MIN);
        case 's':
        case 'S':
            return fixed(n * SEC);
        case 'h':
        case 'H':
            return intraday(n * HOUR);
        case 'd':
        case 'D':
            return fixed(n * DAY);
        case 'w':
        case 'W':
            return fixed(n * WEEK, MONDAY_OFFSET);
        case 'M':
            return months(n);
        case 'y':
        case 'Y':
            return months(12 * n);
        default:
            return null;
    }
}

function tfKey(tf: Timeframe): string {
    return tf.kind === 'fixed' ? `f${tf.ms}@${tf.offset}` : `m${tf.months}`;
}

function bucketOf(tf: Timeframe, t: number): number {
    if (tf.kind === 'fixed') return Math.floor((t - tf.offset) / tf.ms) * tf.ms + tf.offset;
    const d = new Date(t);
    const idx = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / tf.months) * tf.months;
    return Date.UTC(Math.floor(idx / 12), idx % 12, 1);
}

function stepBucket(tf: Timeframe, t: number, dir: 1 | -1): number {
    if (tf.kind === 'fixed') return t + dir * tf.ms;
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir * tf.months, 1);
}

// ── randomness ──────────────────────────────────────────────────────────

type Rng = () => number;

function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** mulberry32 — small, fast, seedable. */
function seededRng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(rng: Rng): number {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ── state ───────────────────────────────────────────────────────────────

interface LivePrice {
    price: number;
    trend: number;
    rng: Rng;
}

interface Series {
    sym: DemoSymbol;
    tf: Timeframe;
    /** Ascending by time; the last bar is the forming one. */
    bars: OHLCV[];
    /** Per-bar return std-dev before the volatility multiplier. */
    sigma: number;
    /** Per-bar log drift (positive ⇒ history trends up toward today). */
    drift: number;
    back: { rng: Rng; trend: number; volState: number };
    fwd: Rng;
    exhausted: boolean;
    subscribers: Set<(bar: OHLCV) => void>;
}

function decimalsOf(tick: number): number {
    return (String(tick).split('.')[1] ?? '').length;
}

function round(price: number, tick: number): number {
    return Number((Math.round(price / tick) * tick).toFixed(decimalsOf(tick)));
}

function exchangeOffset(sym: DemoSymbol): number {
    return sym.prefix === 'CRYPTO' ? 0 : IST_OFFSET;
}

function exchangeTimezone(sym: DemoSymbol): string {
    return sym.prefix === 'CRYPTO' ? 'Etc/UTC' : 'Asia/Kolkata';
}

// ── provider ────────────────────────────────────────────────────────────

export class DemoProvider implements DataProvider {
    private readonly symbols = new Map(DEMO_SYMBOLS.map((s) => [s.ticker, s]));
    private readonly live = new Map<string, LivePrice>();
    private readonly series = new Map<string, Series>();
    private timer: ReturnType<typeof setInterval> | null = null;

    info(): ProviderInfo {
        return {
            name: 'demo',
            displayName: 'Demo Feed',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async listSymbols(): Promise<SymbolDescriptor[]> {
        return DEMO_SYMBOLS.map((s) => ({ ticker: s.ticker, prefix: s.prefix, description: s.description, type: s.type }));
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const sym = this.symbol(ticker);
        if (!sym) return undefined;
        const pricescale = 10 ** decimalsOf(sym.tick);
        return {
            ticker: sym.ticker,
            tickerid: `${sym.prefix}:${sym.ticker}`,
            prefix: sym.prefix,
            description: sym.description,
            type: sym.type,
            currency: sym.currency,
            mintick: sym.tick,
            pricescale,
            minmove: Math.round(sym.tick * pricescale),
            timezone: exchangeTimezone(sym),
            session: '24x7',
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const s = this.seriesFor(ticker, timeframe);
        if (!s) return [];

        if (range.from != null) {
            const from = range.from;
            const to = range.to ?? Infinity;
            while (s.bars[0].time > from && this.canExtend(s)) this.extendBack(s, INITIAL_BARS);
            const out = s.bars.filter((b) => b.time >= from && b.time <= to);
            return (range.limit != null ? out.slice(0, range.limit) : out).map(copy);
        }

        const to = range.to ?? Infinity;
        const limit = range.limit ?? 500;
        let end = upperBound(s.bars, to);
        while (end < limit && this.canExtend(s)) {
            this.extendBack(s, Math.max(limit - end, INITIAL_BARS));
            end = upperBound(s.bars, to);
        }
        return s.bars.slice(Math.max(0, end - limit), end).map(copy);
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
        const s = this.seriesFor(ticker, timeframe);
        if (!s) return () => {};
        s.subscribers.add(onBar);
        return () => s.subscribers.delete(onBar);
    }

    // ── internals ───────────────────────────────────────────────────────

    private symbol(ticker: string): DemoSymbol | undefined {
        return this.symbols.get(ticker.trim().toUpperCase());
    }

    private liveFor(sym: DemoSymbol): LivePrice {
        let lp = this.live.get(sym.ticker);
        if (!lp) {
            lp = { price: sym.basePrice, trend: 0, rng: seededRng(hashString(`live:${sym.ticker}`)) };
            this.live.set(sym.ticker, lp);
        }
        this.startClock();
        return lp;
    }

    private seriesFor(ticker: string, timeframe: string): Series | null {
        const sym = this.symbol(ticker);
        if (!sym) return null;
        const tf = parseTimeframe(timeframe, exchangeOffset(sym));
        if (!tf) {
            console.warn(`[demo] unsupported timeframe "${timeframe}"`);
            return null;
        }
        const key = `${sym.ticker}|${tfKey(tf)}`;
        const existing = this.series.get(key);
        if (existing) return existing;

        const lp = this.liveFor(sym);
        const sigma = sym.vol * Math.sqrt(tf.minutes / MINUTES_PER_YEAR);
        const s: Series = {
            sym,
            tf,
            bars: [],
            sigma,
            drift: sym.drift * (tf.minutes / MINUTES_PER_YEAR),
            back: { rng: seededRng(hashString(key)), trend: 0, volState: 0 },
            fwd: seededRng(hashString(`fwd:${key}`)),
            exhausted: false,
            subscribers: new Set(),
        };

        // The forming bar: it closes at the live price and opened a partial bar ago.
        const now = Date.now();
        const time = bucketOf(tf, now);
        const elapsed = Math.min(1, Math.max(0.05, (now - time) / (stepBucket(tf, time, 1) - time)));
        const close = lp.price;
        const open = close / Math.exp(sigma * Math.sqrt(elapsed) * gaussian(s.back.rng));
        s.bars.push(this.makeBar(s, time, open, close, sigma * Math.sqrt(elapsed), elapsed));
        this.extendBack(s, INITIAL_BARS);
        this.series.set(key, s);
        return s;
    }

    private canExtend(s: Series): boolean {
        return !s.exhausted && s.bars.length < MAX_BARS;
    }

    /** Prepend up to `count` older bars, walking backward from the oldest open. */
    private extendBack(s: Series, count: number): void {
        const { back } = s;
        const older: OHLCV[] = [];
        let close = s.bars[0].open;
        let time = stepBucket(s.tf, s.bars[0].time, -1);
        const n = Math.min(count, MAX_BARS - s.bars.length);
        for (let i = 0; i < n; i++) {
            if (time < EARLIEST) {
                s.exhausted = true;
                break;
            }
            back.volState = 0.97 * back.volState + 0.25 * gaussian(back.rng);
            back.trend = 0.97 * back.trend + 0.25 * gaussian(back.rng);
            const sigma = s.sigma * Math.exp(0.35 * back.volState);
            const ret = sigma * (gaussian(back.rng) + 0.3 * back.trend) + s.drift;
            const open = close / Math.exp(ret);
            older.push(this.makeBar(s, time, open, close, sigma, 1, back.rng));
            close = open;
            time = stepBucket(s.tf, time, -1);
        }
        if (s.bars.length + older.length >= MAX_BARS) s.exhausted = true;
        older.reverse();
        s.bars = older.concat(s.bars);
    }

    private makeBar(s: Series, time: number, open: number, close: number, sigma: number, fraction: number, rng: Rng = s.fwd): OHLCV {
        const wick = sigma * 0.6;
        const high = Math.max(open, close) * Math.exp(Math.abs(gaussian(rng)) * wick);
        const low = Math.min(open, close) * Math.exp(-Math.abs(gaussian(rng)) * wick);
        const activity = 1 + 0.6 * Math.abs(Math.log(close / open)) / Math.max(sigma, 1e-9);
        const volume = s.sym.volumePerMin * s.tf.minutes * fraction * activity * (0.5 + rng());
        const tick = s.sym.tick;
        return {
            time,
            open: round(open, tick),
            high: round(high, tick),
            low: round(low, tick),
            close: round(close, tick),
            volume: Math.round(volume),
        };
    }

    private startClock(): void {
        if (this.timer || typeof window === 'undefined') return;
        this.timer = setInterval(() => this.tick(), TICK_MS);
    }

    /** Advance every live price one step and fold it into each of its series. */
    private tick(): void {
        const now = Date.now();
        const dtMinutes = TICK_MS / MIN;
        for (const [ticker, lp] of this.live) {
            const sym = this.symbols.get(ticker)!;
            lp.trend = 0.998 * lp.trend + 0.06 * gaussian(lp.rng);
            const sigma = sym.vol * Math.sqrt(dtMinutes / MINUTES_PER_YEAR);
            lp.price *= Math.exp(sigma * (gaussian(lp.rng) + 0.15 * lp.trend));
            const volume = sym.volumePerMin * dtMinutes * (0.3 + 1.4 * lp.rng());
            for (const s of this.series.values()) {
                if (s.sym !== sym) continue;
                const closed = this.applyPrice(s, now, lp.price, volume);
                for (const cb of s.subscribers) {
                    for (const bar of closed) cb(copy(bar));
                    cb(copy(s.bars[s.bars.length - 1]));
                }
            }
        }
    }

    /** Update the forming bar, rolling into new buckets as time passes. Returns the bars
     *  that closed on this step (the previous forming bar plus any gap fill). */
    private applyPrice(s: Series, now: number, price: number, volume: number): OHLCV[] {
        const tick = s.sym.tick;
        const p = round(price, tick);
        const time = bucketOf(s.tf, now);
        const last = s.bars[s.bars.length - 1];

        if (time <= last.time) {
            last.close = p;
            last.high = Math.max(last.high, p);
            last.low = Math.min(last.low, p);
            last.volume = Math.round((last.volume ?? 0) + volume);
            return [];
        }

        // Buckets skipped while the tab slept: bridge them so the walk lands on `price`.
        const gap: number[] = [];
        for (let t = stepBucket(s.tf, last.time, 1); t < time && gap.length < MAX_GAP_FILL; t = stepBucket(s.tf, t, 1)) gap.push(t);
        const closed = [last];
        let open = last.close;
        if (gap.length > 0) {
            const from = Math.log(last.close);
            const to = Math.log(price);
            const steps = gap.length + 1;
            const walk = [0];
            for (let i = 1; i <= steps; i++) walk.push(walk[i - 1] + s.sigma * gaussian(s.fwd));
            for (let i = 0; i < gap.length; i++) {
                const k = i + 1;
                const level = from + ((to - from) * k) / steps + walk[k] - (k / steps) * walk[steps];
                const close = Math.exp(level);
                const bar = this.makeBar(s, gap[i], open, close, s.sigma, 1);
                s.bars.push(bar);
                closed.push(bar);
                open = close;
            }
        }
        const o = round(open, tick);
        s.bars.push({ time, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p, volume: Math.round(volume) });
        if (s.bars.length > MAX_BARS) s.bars.splice(0, s.bars.length - MAX_BARS);
        return closed;
    }
}

function copy(b: OHLCV): OHLCV {
    return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

/** Number of bars with `time <= t` (bars ascending). */
function upperBound(bars: OHLCV[], t: number): number {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bars[mid].time <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
