import { describe, expect, it } from 'vitest'
import { lastSessionDate, marketClock, metaExpiry, minutesUntilOpen, quotesExpiry, zonedEpoch } from '../shared/clock'
import { MARKET_IDS, MARKETS } from '../shared/markets'

const at = (iso: string) => new Date(iso)
const t = (iso: string) => Date.parse(iso)
const { us, cn, hk, jp } = MARKETS

describe('marketClock', () => {
  it('reads phases in New York time (EDT)', () => {
    expect(marketClock(us, at('2026-10-20T12:00:00Z')).phase).toBe('pre') // 08:00
    expect(marketClock(us, at('2026-10-20T13:30:00Z')).phase).toBe('regular') // 09:30
    expect(marketClock(us, at('2026-10-20T19:59:00Z')).phase).toBe('regular') // 15:59
    expect(marketClock(us, at('2026-10-20T20:00:00Z')).phase).toBe('post') // 16:00
    expect(marketClock(us, at('2026-10-21T00:00:00Z')).phase).toBe('closed') // 20:00
    expect(marketClock(us, at('2026-10-20T07:59:00Z')).phase).toBe('closed') // 03:59
  })

  it('follows the DST switch', () => {
    // 2026-11-02 is EST: 14:15Z = 09:15, 14:45Z = 09:45.
    expect(marketClock(us, at('2026-11-02T14:15:00Z')).phase).toBe('pre')
    expect(marketClock(us, at('2026-11-02T14:45:00Z')).phase).toBe('regular')
  })

  it('closes on weekends and holidays', () => {
    expect(marketClock(us, at('2026-10-24T15:00:00Z')).phase).toBe('closed') // Saturday
    expect(marketClock(us, at('2026-11-26T16:00:00Z'))).toMatchObject({ phase: 'closed', isTradingDay: false }) // Thanksgiving
  })

  it('ends early-close days at 13:00', () => {
    // 2026-11-27, EST: 17:30Z = 12:30, 18:30Z = 13:30.
    expect(marketClock(us, at('2026-11-27T17:30:00Z')).phase).toBe('regular')
    expect(marketClock(us, at('2026-11-27T18:30:00Z'))).toMatchObject({ phase: 'post', earlyClose: true })
  })

  it('has a lunch break in Shanghai, Hong Kong and Tokyo, and no extended hours', () => {
    // Beijing = UTC+8.
    expect(marketClock(cn, at('2026-10-20T01:00:00Z')).phase).toBe('closed') // 09:00
    expect(marketClock(cn, at('2026-10-20T01:30:00Z')).phase).toBe('regular') // 09:30
    expect(marketClock(cn, at('2026-10-20T04:00:00Z')).phase).toBe('break') // 12:00
    expect(marketClock(cn, at('2026-10-20T05:00:00Z')).phase).toBe('regular') // 13:00
    expect(marketClock(cn, at('2026-10-20T07:00:00Z')).phase).toBe('closed') // 15:00
    expect(marketClock(hk, at('2026-10-20T04:30:00Z')).phase).toBe('break') // 12:30
    expect(marketClock(hk, at('2026-10-20T07:30:00Z')).phase).toBe('regular') // 15:30
    // Tokyo = UTC+9: 15:20 is still the afternoon session.
    expect(marketClock(jp, at('2026-10-20T06:20:00Z')).phase).toBe('regular')
  })

  it('dates trading days in the market\'s own zone', () => {
    // Tuesday 08:30 in Tokyo is still Monday in New York.
    expect(marketClock(jp, at('2026-10-19T23:30:00Z'))).toMatchObject({ date: '2026-10-20', phase: 'closed', isTradingDay: true })
  })
})

describe('minutesUntilOpen', () => {
  it('counts across a weekend', () => {
    // Friday 2026-10-23 17:00 EDT → Monday 09:30 EDT = 2 days 16.5 hours.
    expect(minutesUntilOpen(us, at('2026-10-23T21:00:00Z'))).toBe((2 * 24 + 16) * 60 + 30)
  })
  it('is zero in session', () => {
    expect(minutesUntilOpen(us, at('2026-10-20T15:00:00Z'))).toBe(0)
  })
  it('skips holidays', () => {
    // Wed 2026-11-25 20:00 EST → Fri 2026-11-27 09:30 (Thanksgiving skipped).
    expect(minutesUntilOpen(us, at('2026-11-26T01:00:00Z'))).toBe((4 + 24 + 9) * 60 + 30)
  })
  it('counts to the afternoon session over lunch', () => {
    expect(minutesUntilOpen(cn, at('2026-10-20T04:00:00Z'))).toBe(60) // 12:00 → 13:00
  })
})

describe('lastSessionDate', () => {
  it('is today once the bell rings, else the prior trading day', () => {
    expect(lastSessionDate(us, at('2026-10-20T15:00:00Z'))).toBe('2026-10-20')
    expect(lastSessionDate(us, at('2026-10-20T12:00:00Z'))).toBe('2026-10-19')
    expect(lastSessionDate(us, at('2026-10-26T12:00:00Z'))).toBe('2026-10-23') // Monday pre-market → Friday
  })
})

describe('quotesExpiry', () => {
  it('follows each market\'s cadence in session', () => {
    expect(quotesExpiry(us, t('2026-10-20T15:00:00Z')) - t('2026-10-20T15:00:00Z')).toBe(60_000)
    expect(quotesExpiry(us, t('2026-10-20T21:00:00Z')) - t('2026-10-20T21:00:00Z')).toBe(us.extRefresh)
    expect(quotesExpiry(cn, t('2026-10-20T02:00:00Z')) - t('2026-10-20T02:00:00Z')).toBe(cn.refresh)
  })
  it('takes one more look once the post-market prints settle', () => {
    // 20:10 EDT → 20:20.
    expect(quotesExpiry(us, t('2026-10-21T00:10:00Z'))).toBe(t('2026-10-21T00:20:00Z'))
  })
  it('holds settled data until the next pre-market, across weekends', () => {
    // Friday 21:00 EDT → Monday 04:20 EDT.
    expect(quotesExpiry(us, t('2026-10-24T01:00:00Z'))).toBe(t('2026-10-26T08:20:00Z'))
    // Across the DST switch: Saturday 2026-10-31 → Monday 2026-11-02 04:20 EST.
    expect(quotesExpiry(us, t('2026-10-31T16:00:00Z'))).toBe(t('2026-11-02T09:20:00Z'))
  })
  it('skips the lunch break once the morning has settled', () => {
    // 11:35 Beijing: catch-up at 11:50, then nothing until 13:00 + feed delay.
    expect(quotesExpiry(cn, t('2026-10-20T03:35:00Z'))).toBe(t('2026-10-20T03:50:00Z'))
    expect(quotesExpiry(cn, t('2026-10-20T03:50:00Z'))).toBe(t('2026-10-20T05:15:00Z'))
  })
  it('holds a closed Asian market until the next open plus delay', () => {
    // Friday 16:00 Beijing → Monday 09:45.
    expect(quotesExpiry(cn, t('2026-10-23T08:00:00Z'))).toBe(t('2026-10-26T01:45:00Z'))
  })
})

describe('metaExpiry', () => {
  it('turns over at the start of the next trading day', () => {
    expect(metaExpiry(us, t('2026-10-20T15:00:00Z'))).toBe(t('2026-10-21T08:00:00Z')) // 04:00 EDT
    expect(metaExpiry(cn, t('2026-10-23T08:00:00Z'))).toBe(t('2026-10-26T01:30:00Z')) // Monday 09:30
  })
})

describe('zonedEpoch', () => {
  it('converts wall time in both DST regimes', () => {
    expect(zonedEpoch('America/New_York', '2026-10-20', 9 * 60 + 30)).toBe(t('2026-10-20T13:30:00Z'))
    expect(zonedEpoch('America/New_York', '2026-12-01', 9 * 60 + 30)).toBe(t('2026-12-01T14:30:00Z'))
    expect(zonedEpoch('Australia/Sydney', '2026-10-20', 10 * 60)).toBe(t('2026-10-19T23:00:00Z')) // AEDT
  })
})

describe('KV write budget', () => {
  // Worst case: every market open in a browser all week, so each one refreshes
  // as soon as its data expires. Writes are counted per UTC day, which is how
  // the free plan's 1,000-a-day limit resets.
  it('stays inside the free plan even if every market is watched all day', () => {
    const MIN = 60_000
    const start = t('2026-10-18T00:00:00Z') // Sunday
    const days = new Map<string, number>()
    const bump = (now: number) => {
      const d = new Date(now).toISOString().slice(0, 10)
      days.set(d, (days.get(d) ?? 0) + 1)
    }
    for (const id of MARKET_IDS) {
      const m = MARKETS[id]
      let quotes = 0
      let meta = 0
      for (let now = start; now < start + 7 * 24 * 60 * MIN; now += MIN) {
        if (now >= quotes) {
          quotes = quotesExpiry(m, now)
          bump(now)
        }
        if (now >= meta) {
          meta = metaExpiry(m, now)
          bump(now)
        }
      }
    }
    const worst = Math.max(...days.values())
    expect(worst).toBeLessThan(950)
  })
})
