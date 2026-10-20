import { describe, expect, it } from 'vitest'
import { lastSessionDate, marketClock, minutesUntilOpen, nyEpoch, quotesExpiry } from '../shared/market'

const at = (iso: string) => new Date(iso)

describe('marketClock', () => {
  it('reads phases in New York time (EDT)', () => {
    expect(marketClock(at('2026-10-20T12:00:00Z')).phase).toBe('pre') // 08:00
    expect(marketClock(at('2026-10-20T13:30:00Z')).phase).toBe('regular') // 09:30
    expect(marketClock(at('2026-10-20T19:59:00Z')).phase).toBe('regular') // 15:59
    expect(marketClock(at('2026-10-20T20:00:00Z')).phase).toBe('post') // 16:00
    expect(marketClock(at('2026-10-21T00:00:00Z')).phase).toBe('closed') // 20:00
    expect(marketClock(at('2026-10-20T07:59:00Z')).phase).toBe('closed') // 03:59
  })

  it('follows the DST switch', () => {
    // 2026-11-02 is EST: 14:15Z = 09:15, 14:45Z = 09:45.
    expect(marketClock(at('2026-11-02T14:15:00Z')).phase).toBe('pre')
    expect(marketClock(at('2026-11-02T14:45:00Z')).phase).toBe('regular')
  })

  it('closes on weekends and holidays', () => {
    expect(marketClock(at('2026-10-24T15:00:00Z')).phase).toBe('closed') // Saturday
    expect(marketClock(at('2026-11-26T16:00:00Z'))).toMatchObject({ phase: 'closed', isTradingDay: false }) // Thanksgiving
  })

  it('ends early-close days at 13:00', () => {
    // 2026-11-27, EST: 17:30Z = 12:30, 18:30Z = 13:30.
    expect(marketClock(at('2026-11-27T17:30:00Z')).phase).toBe('regular')
    expect(marketClock(at('2026-11-27T18:30:00Z'))).toMatchObject({ phase: 'post', earlyClose: true })
  })
})

describe('minutesUntilOpen', () => {
  it('counts across a weekend', () => {
    // Friday 2026-10-23 17:00 EDT → Monday 09:30 EDT = 2 days 16.5 hours.
    expect(minutesUntilOpen(at('2026-10-23T21:00:00Z'))).toBe((2 * 24 + 16) * 60 + 30)
  })
  it('is zero in session', () => {
    expect(minutesUntilOpen(at('2026-10-20T15:00:00Z'))).toBe(0)
  })
  it('skips holidays', () => {
    // Wed 2026-11-25 20:00 EST → Fri 2026-11-27 09:30 (Thanksgiving skipped).
    expect(minutesUntilOpen(at('2026-11-26T01:00:00Z'))).toBe((4 + 24 + 9) * 60 + 30)
  })
})

describe('lastSessionDate', () => {
  it('is today once the bell rings, else the prior trading day', () => {
    expect(lastSessionDate(at('2026-10-20T15:00:00Z'))).toBe('2026-10-20')
    expect(lastSessionDate(at('2026-10-20T12:00:00Z'))).toBe('2026-10-19')
    expect(lastSessionDate(at('2026-10-26T12:00:00Z'))).toBe('2026-10-23') // Monday pre-market → Friday
  })
})

describe('quotesExpiry', () => {
  const t = (iso: string) => Date.parse(iso)
  it('lasts a minute in session and five in extended hours', () => {
    expect(quotesExpiry(t('2026-10-20T15:00:00Z')) - t('2026-10-20T15:00:00Z')).toBe(60_000)
    expect(quotesExpiry(t('2026-10-20T21:00:00Z')) - t('2026-10-20T21:00:00Z')).toBe(300_000)
  })
  it('waits for the post-market prints to settle', () => {
    // 20:10 EDT: within the settling window.
    expect(quotesExpiry(t('2026-10-21T00:10:00Z')) - t('2026-10-21T00:10:00Z')).toBe(300_000)
  })
  it('holds settled data until the next pre-market, across weekends', () => {
    // Friday 21:00 EDT → Monday 04:20 EDT.
    expect(quotesExpiry(t('2026-10-24T01:00:00Z'))).toBe(t('2026-10-26T08:20:00Z'))
    // Across the DST switch: Saturday 2026-10-31 → Monday 2026-11-02 04:20 EST.
    expect(quotesExpiry(t('2026-10-31T16:00:00Z'))).toBe(t('2026-11-02T09:20:00Z'))
  })
})

describe('nyEpoch', () => {
  it('converts New York wall time in both DST regimes', () => {
    expect(nyEpoch('2026-10-20', 9 * 60 + 30)).toBe(Date.parse('2026-10-20T13:30:00Z'))
    expect(nyEpoch('2026-12-01', 9 * 60 + 30)).toBe(Date.parse('2026-12-01T14:30:00Z'))
  })
})
