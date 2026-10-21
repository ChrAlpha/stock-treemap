// Trading-session clock for any market in shared/markets.ts, evaluated in the
// market's own time zone. Shared by the Worker (refresh cadence) and the
// client (status + polling).

import type { MarketSpec, Segment } from './markets'

export type MarketPhase = 'pre' | 'regular' | 'break' | 'post' | 'closed'

export interface MarketClock {
  phase: MarketPhase
  /** Trading-calendar date in the market's time zone, YYYY-MM-DD. */
  date: string
  /** Minutes since local midnight. */
  minutes: number
  isTradingDay: boolean
  earlyClose: boolean
}

const MIN = 60_000

const offsetFmts = new Map<string, Intl.DateTimeFormat>()
const partFmts = new Map<string, Intl.DateTimeFormat>()

function cached(map: Map<string, Intl.DateTimeFormat>, tz: string, make: () => Intl.DateTimeFormat) {
  let f = map.get(tz)
  if (!f)
    map.set(tz, (f = make()))
  return f
}

/** A zone's UTC offset at an instant, in minutes (−240 in New York in summer). */
function offsetMinutes(tz: string, at: number) {
  const fmt = cached(offsetFmts, tz, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }))
  const name = fmt.formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = name.match(/([+-])(\d{2}):?(\d{2})?/)
  if (!m)
    return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

/** Epoch ms for a wall-clock time in `tz`. */
export function zonedEpoch(tz: string, date: string, minutes: number) {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * MIN
  // Two passes settle the offset even right next to a DST switch.
  let t = wall - offsetMinutes(tz, wall) * MIN
  t = wall - offsetMinutes(tz, t) * MIN
  return t
}

function partsOf(tz: string, at: Date) {
  const fmt = cached(partFmts, tz, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }))
  const p: Record<string, string> = {}
  for (const { type, value } of fmt.formatToParts(at))
    p[type] = value
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function isTradingDate(m: MarketSpec, date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return day !== 0 && day !== 6 && !m.holidays?.has(date)
}

/** The day's regular sessions with any early close applied. */
function sessionsOf(m: MarketSpec, date: string): Segment[] {
  const early = m.earlyCloses?.get(date)
  if (early == null)
    return m.sessions
  return m.sessions.filter(s => s.open < early).map(s => ({ open: s.open, close: Math.min(s.close, early) }))
}

function dayOf(m: MarketSpec, date: string) {
  const sessions = sessionsOf(m, date)
  const open = sessions[0]!.open
  const close = sessions.at(-1)!.close
  return { sessions, start: m.pre ?? open, open, close, end: close + (m.post ?? 0) }
}

export function marketClock(m: MarketSpec, at: Date = new Date()): MarketClock {
  const { date, minutes } = partsOf(m.tz, at)
  const isTradingDay = isTradingDate(m, date)
  const day = dayOf(m, date)
  let phase: MarketPhase = 'closed'
  if (isTradingDay) {
    if (day.sessions.some(s => minutes >= s.open && minutes < s.close))
      phase = 'regular'
    else if (minutes >= day.start && minutes < day.open)
      phase = 'pre'
    else if (minutes >= day.close && minutes < day.end)
      phase = 'post'
    else if (minutes >= day.open && minutes < day.close)
      phase = 'break'
  }
  return { phase, date, minutes, isTradingDay, earlyClose: m.earlyCloses?.has(date) ?? false }
}

/** Next regular-session open strictly after `at` (the afternoon session counts). */
export function nextOpenAt(m: MarketSpec, at: Date = new Date()) {
  const { date, minutes } = partsOf(m.tz, at)
  let d = date
  for (let i = 0; i < 15; i++, d = addDays(d, 1)) {
    if (!isTradingDate(m, d))
      continue
    const next = sessionsOf(m, d).find(s => i > 0 || s.open > minutes)
    if (next)
      return zonedEpoch(m.tz, d, next.open)
  }
  return at.getTime() + 24 * 60 * MIN
}

/** Minutes until the next regular-session open (0 while open). */
export function minutesUntilOpen(m: MarketSpec, at: Date = new Date()) {
  if (marketClock(m, at).phase === 'regular')
    return 0
  return Math.max(0, Math.ceil((nextOpenAt(m, at) - at.getTime()) / MIN))
}

/** Start of the next trading day's activity (pre-market where there is one), strictly after `at`. */
export function nextStartAt(m: MarketSpec, at: Date = new Date()) {
  const { date, minutes } = partsOf(m.tz, at)
  let d = date
  if (!(isTradingDate(m, d) && minutes < dayOf(m, d).start))
    d = addDays(d, 1)
  for (let i = 0; i < 14 && !isTradingDate(m, d); i++)
    d = addDays(d, 1)
  return zonedEpoch(m.tz, d, dayOf(m, d).start)
}

/** The most recent date whose regular session has started (today once open, else the previous trading day). */
export function lastSessionDate(m: MarketSpec, at: Date = new Date()) {
  const clock = marketClock(m, at)
  let date = clock.date
  if (!clock.isTradingDay || clock.minutes < dayOf(m, date).open)
    date = addDays(date, -1)
  for (let i = 0; i < 14 && !isTradingDate(m, date); i++)
    date = addDays(date, -1)
  return date
}

/**
 * When quotes fetched at `fetchedAt` stop being current. In session that's
 * the market's refresh cadence. Once a session ends there is one more look
 * after its delayed prints and closing auction have landed; after that
 * nothing changes until the next open plus the feed delay, so the data stays
 * good through lunch, nights, weekends and holidays without another upstream
 * call.
 */
export function quotesExpiry(m: MarketSpec, fetchedAt: number) {
  const c = marketClock(m, new Date(fetchedAt))
  if (c.phase === 'regular')
    return fetchedAt + m.refresh
  if (c.phase === 'pre' || c.phase === 'post')
    return fetchedAt + (m.extRefresh ?? m.refresh)

  if (c.isTradingDay) {
    const day = dayOf(m, c.date)
    // Most recent session (or post-market) end today.
    const ends = [...day.sessions.map(s => s.close), day.end].filter(e => e <= c.minutes)
    const ended = ends.length ? Math.max(...ends) : null
    if (ended != null && c.minutes < ended + m.settle)
      return zonedEpoch(m.tz, c.date, ended + m.settle)
    if (c.phase === 'break') {
      const next = day.sessions.find(s => s.open > c.minutes)!
      return zonedEpoch(m.tz, c.date, next.open + m.delay)
    }
  }
  return nextStartAt(m, new Date(fetchedAt)) + m.delay * MIN
}

/**
 * The source says the market hasn't traded today although the calendar says
 * it's open: a holiday we don't keep a list for. Look again in a while.
 */
export const HOLIDAY_RECHECK = 30 * MIN

/** Reference data (names, taxonomy, index membership) turns over at most once per trading day. */
export function metaExpiry(m: MarketSpec, updatedAt: number) {
  return nextStartAt(m, new Date(updatedAt))
}
