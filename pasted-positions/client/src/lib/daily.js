// Rows of the NIFTY 50 daily analysis table: each one compares the LTP with a level from the daily candles.
// `tone` colours the status: up (green), down (red), warn (amber) or muted; it also gives the row's `bias`.

export const NEAR_PCT = 0.25; // today's high and low
export const NEAR_EXTREME_PCT = 2; // the all-time high and the 52-week low
const NONE = { status: '—', tone: 'muted', bias: null }; // no data: no bias either
// Green rows are bullish, red bearish, amber (an inside candle) sideways, the rest neutral
const TONE_BIAS = { up: 'Bullish', down: 'Bearish', warn: 'Sideways', muted: 'Neutral' };
export const BIAS_TONE = { Bullish: 'up', Bearish: 'down', Sideways: 'warn', Neutral: 'muted' };

/** "2026-10-30" → "30-10-2026" */
export function dayLabel(date) {
  const [year, month, day] = date.split('-');
  return `${day}-${month}-${year}`;
}

function versus(ltp, level) {
  if (level === null || level === undefined) return NONE;
  return ltp >= level ? { status: 'Above', tone: 'up' } : { status: 'Below', tone: 'down' };
}

function candleColour(open, close) {
  return close >= open ? { status: 'Green', tone: 'up' } : { status: 'Red', tone: 'down' };
}

/** Within `limit` % shows in `tone`, further away muted. */
function near(distance, tone, limit = NEAR_PCT) {
  if (distance === null) return NONE;
  return { status: `${distance.toFixed(2)}%`, tone: distance < limit ? tone : 'muted' };
}

/**
 * Table rows for a `daily` update from the server, in the order of the reference table, with the new rows next
 * to their kin: [{ key, label, status, tone, bias, value, title? }]. `value` is the level compared with (null
 * when there is none); `bias` is Bullish, Bearish, Sideways or Neutral, null without data.
 */
export function dailyRows(daily) {
  const { ltp, today, prevDay, prevWeek, prevGreen, prevRed, allTimeHigh, low52Week, ema } = daily;
  const day = prevDay ? ` (${dayLabel(prevDay.date)})` : '';
  const week = prevWeek ? ` (${dayLabel(prevWeek.from)} to ${dayLabel(prevWeek.to)})` : '';
  const highGap = today ? ((today.high - ltp) / ltp) * 100 : null;
  const lowGap = today ? ((ltp - today.low) / ltp) * 100 : null;
  const athGap = allTimeHigh ? ((allTimeHigh.value - ltp) / ltp) * 100 : null;
  const yearLowGap = low52Week ? ((ltp - low52Week.value) / ltp) * 100 : null;
  const emaGap = ema[5] === null || ema[21] === null ? null : ((ema[5] - ema[21]) / ltp) * 100;
  const inside = today && prevDay ? today.high <= prevDay.high && today.low >= prevDay.low : null;
  const atHigh = allTimeHigh ? allTimeHigh.before === null || ltp >= allTimeHigh.before : null;
  const emaRow = (period) => ({
    key: `ema${period}`,
    label: `LTP vs ${period} EMA`,
    ...versus(ltp, ema[period]),
    value: ema[period],
    title: `${period}-day EMA of the close, with today's LTP as today's close`,
  });

  const rows = [
    { key: 'prevDayLow', label: `Prev Day Low${day}`, ...versus(ltp, prevDay?.low), value: prevDay?.low ?? null },
    {
      key: 'prevGreenLow',
      label: 'LTP vs Prev Green Low',
      ...versus(ltp, prevGreen?.low),
      value: prevGreen?.low ?? null,
      title: prevGreen ? `Low of the last green day, ${dayLabel(prevGreen.date)}` : undefined,
    },
    { key: 'prevWeekLow', label: `Prev Week Low${week}`, ...versus(ltp, prevWeek?.low), value: prevWeek?.low ?? null },
    { key: 'prevWeekClose', label: `Prev Week Close${week}`, ...versus(ltp, prevWeek?.close), value: prevWeek?.close ?? null },
    {
      key: 'currentCandle',
      label: 'Current Candle',
      ...(today ? candleColour(today.open, ltp) : NONE),
      value: null,
      title: "Today up or down: the LTP against today's open",
    },
    {
      key: 'previousCandle',
      label: 'Previous Candle',
      ...(prevDay ? candleColour(prevDay.open, prevDay.close) : NONE),
      value: null,
    },
    {
      key: 'nearHigh',
      label: `Near To High (Bullish) (<${NEAR_PCT}%)`,
      ...near(highGap, 'up'),
      value: today?.high ?? null,
      title: "How far the LTP is below today's high (the value)",
    },
    {
      key: 'nearLow',
      label: `Near To Low (Bearish) (<${NEAR_PCT}%)`,
      ...near(lowGap, 'down'),
      value: today?.low ?? null,
      title: "How far the LTP is above today's low (the value)",
    },
    {
      key: 'inside',
      label: 'Is Inside Candle? (Sideways)',
      ...(inside === null ? NONE : inside ? { status: 'Yes', tone: 'warn' } : { status: 'No', tone: 'muted' }),
      value: null,
      title: "Today's high and low are within the previous day's",
    },
    {
      key: 'allTimeHigh',
      label: 'At All-Time High?',
      ...(atHigh === null ? NONE : atHigh ? { status: 'Yes', tone: 'up' } : { status: 'No', tone: 'muted' }),
      value: allTimeHigh?.value ?? null,
      title: allTimeHigh
        ? `Highest high, on ${dayLabel(allTimeHigh.date)} (daily candles since ${dayLabel(allTimeHigh.since ?? daily.date)})`
        : undefined,
    },
    {
      key: 'athDistance',
      label: `Distance From All-Time High (Bullish) (<${NEAR_EXTREME_PCT}%)`,
      ...near(athGap, 'up', NEAR_EXTREME_PCT),
      value: allTimeHigh?.value ?? null,
      title: 'How far the LTP is below the all-time high (the value)',
    },
    {
      key: 'low52Week',
      label: `Distance From 52-Week Low (Bearish) (<${NEAR_EXTREME_PCT}%)`,
      ...near(yearLowGap, 'down', NEAR_EXTREME_PCT),
      value: low52Week?.value ?? null,
      title: low52Week
        ? `How far the LTP is above the lowest low of the past year (the value), on ${dayLabel(low52Week.date)}`
        : undefined,
    },
    emaRow(5),
    emaRow(21),
    emaRow(252),
    {
      key: 'emaSpread',
      label: '5 vs 21 EMA Distance',
      ...(emaGap === null
        ? NONE
        : { status: `${emaGap > 0 ? '+' : ''}${emaGap.toFixed(2)}%`, tone: emaGap > 0 ? 'up' : emaGap < 0 ? 'down' : 'muted' }),
      value: null,
      title: '(5 EMA − 21 EMA) ÷ LTP: positive while the 5 EMA is above the 21 EMA',
    },
    { key: 'prevDayClose', label: `Prev Day Close${day}`, ...versus(ltp, prevDay?.close), value: prevDay?.close ?? null },
    { key: 'prevDayHigh', label: `Prev Day High${day}`, ...versus(ltp, prevDay?.high), value: prevDay?.high ?? null },
    {
      key: 'prevRedHigh',
      label: 'LTP vs Prev Red High',
      ...versus(ltp, prevRed?.high),
      value: prevRed?.high ?? null,
      title: prevRed ? `High of the last red day, ${dayLabel(prevRed.date)}` : undefined,
    },
    { key: 'prevWeekHigh', label: `Prev Week High${week}`, ...versus(ltp, prevWeek?.high), value: prevWeek?.high ?? null },
  ];
  return rows.map((row) => ({ bias: TONE_BIAS[row.tone], ...row }));
}

/** How many rows lean each way, and the verdict: the side with more rows, Neutral when even. */
export function biasTally(rows) {
  const counts = { Bullish: 0, Bearish: 0, Neutral: 0, Sideways: 0 };
  for (const { bias } of rows) if (bias) counts[bias] += 1;
  const verdict =
    counts.Bullish > counts.Bearish ? 'Bullish' : counts.Bearish > counts.Bullish ? 'Bearish' : 'Neutral';
  return { counts, verdict };
}
