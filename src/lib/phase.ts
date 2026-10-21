import type { MarketClock } from '~shared/clock'
import type { MarketSpec } from '~shared/markets'

export interface PhaseLabel {
  label: string
  /** For tight spots (the market list). */
  short: string
  live: boolean
}

/** `holiday`: the source says the market isn't trading today although the calendar says it should. */
export function phaseLabel(m: MarketSpec, c: MarketClock, holiday = false): PhaseLabel {
  if (holiday && (c.phase === 'regular' || c.phase === 'break'))
    return { label: '休市', short: '休市', live: false }
  switch (c.phase) {
    case 'regular': return { label: '交易中', short: '交易中', live: true }
    case 'break': return { label: '午间休市', short: '午休', live: false }
    case 'pre': return { label: '盘前交易', short: '盘前', live: false }
    case 'post': return { label: '盘后交易', short: '盘后', live: false }
  }
  if (!c.isTradingDay)
    return { label: '休市', short: '休市', live: false }
  return c.minutes < (m.pre ?? m.sessions[0]!.open)
    ? { label: '未开盘', short: '未开盘', live: false }
    : { label: '已收盘', short: '已收盘', live: false }
}
