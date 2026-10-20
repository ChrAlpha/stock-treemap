// US equity session clock, evaluated in America/New_York.
// Shared by the Worker (refresh cadence) and the client (status + polling).

export type MarketPhase = 'pre' | 'regular' | 'post' | 'closed'

// NYSE full-day closures. Extend yearly.
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
])

// 13:00 ET close.
const EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26'])

const PRE_OPEN = 4 * 60
const OPEN = 9 * 60 + 30
const CLOSE = 16 * 60
const EARLY_CLOSE = 13 * 60
const POST_LEN = 4 * 60

export interface MarketClock {
  phase: MarketPhase
  /** Trading-calendar date in New York, YYYY-MM-DD. */
  date: string
  /** Minutes since midnight, New York. */
  minutes: number
  isTradingDay: boolean
  earlyClose: boolean
}

const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })

/** New York's UTC offset at an instant, in minutes (−240 in EDT). */
function offsetMinutes(at: number) {
  const name = offsetFmt.formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-05:00'
  const m = name.match(/([+-])(\d{2}):?(\d{2})?/)
  if (!m)
    return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

/** Epoch ms for a New York wall-clock time. */
export function nyEpoch(date: string, minutes: number) {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000
  // Two passes settle the offset even right next to a DST switch.
  let t = wall - offsetMinutes(wall) * 60_000
  t = wall - offsetMinutes(t) * 60_000
  return t
}

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
})

function partsOf(at: Date) {
  const p: Record<string, string> = {}
  for (const { type, value } of etParts.formatToParts(at))
    p[type] = value
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: p.weekday!,
  }
}

export function isTradingDate(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return day !== 0 && day !== 6 && !HOLIDAYS.has(date)
}

function sessionOf(date: string) {
  const earlyClose = EARLY_CLOSES.has(date)
  const close = earlyClose ? EARLY_CLOSE : CLOSE
  return { open: OPEN, close, postEnd: close + POST_LEN, earlyClose }
}

export function marketClock(at: Date = new Date()): MarketClock {
  const { date, minutes } = partsOf(at)
  const isTradingDay = isTradingDate(date)
  const { open, close, postEnd, earlyClose } = sessionOf(date)
  let phase: MarketPhase = 'closed'
  if (isTradingDay) {
    if (minutes >= PRE_OPEN && minutes < open)
      phase = 'pre'
    else if (minutes >= open && minutes < close)
      phase = 'regular'
    else if (minutes >= close && minutes < postEnd)
      phase = 'post'
  }
  return { phase, date, minutes, isTradingDay, earlyClose }
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Minutes until the next regular-session open (0 while open). */
export function minutesUntilOpen(at: Date = new Date()) {
  const clock = marketClock(at)
  if (clock.phase === 'regular')
    return 0
  if (clock.isTradingDay && clock.minutes < OPEN)
    return OPEN - clock.minutes
  let ahead = 24 * 60 - clock.minutes
  let date = addDays(clock.date, 1)
  for (let i = 0; i < 14 && !isTradingDate(date); i++) {
    ahead += 24 * 60
    date = addDays(date, 1)
  }
  return ahead + OPEN
}

/** The most recent date whose regular session has started (today once open, else the previous trading day). */
export function lastSessionDate(at: Date = new Date()) {
  const clock = marketClock(at)
  let date = clock.date
  if (!clock.isTradingDay || clock.minutes < OPEN)
    date = addDays(date, -1)
  for (let i = 0; i < 14 && !isTradingDate(date); i++)
    date = addDays(date, -1)
  return date
}

export function nyDate(at: Date) {
  return partsOf(at).date
}

/** Next 04:00 New York on a trading day, strictly after `at`. */
export function nextPreOpenAt(at: Date = new Date()) {
  const clock = marketClock(at)
  let date = clock.date
  if (!(clock.isTradingDay && clock.minutes < PRE_OPEN))
    date = addDays(date, 1)
  for (let i = 0; i < 14 && !isTradingDate(date); i++)
    date = addDays(date, 1)
  return nyEpoch(date, PRE_OPEN)
}

// Quotes run ~15 minutes behind; allow that long for the last prints of a session to land.
const SETTLE = 20

/**
 * When quotes fetched at `fetchedAt` stop being current. In session that's a
 * minute (five in extended hours); once a session's delayed prints have
 * settled, nothing changes until the next pre-market, so the data stays good
 * through nights, weekends and holidays without another upstream call.
 */
export function quotesExpiry(fetchedAt: number) {
  const clock = marketClock(new Date(fetchedAt))
  if (clock.phase === 'regular')
    return fetchedAt + 60_000
  if (clock.phase === 'pre' || clock.phase === 'post')
    return fetchedAt + 5 * 60_000
  const { postEnd } = sessionOf(clock.date)
  if (clock.isTradingDay && clock.minutes >= postEnd && clock.minutes < postEnd + SETTLE)
    return fetchedAt + 5 * 60_000
  return nextPreOpenAt(new Date(fetchedAt)) + SETTLE * 60_000
}

/** Reference data (names, taxonomy, index membership) turns over at most once per trading day. */
export function metaExpiry(updatedAt: number) {
  return nextPreOpenAt(new Date(updatedAt))
}
