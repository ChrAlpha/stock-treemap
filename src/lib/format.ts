const MINUS = '−'

/** +0.42% / −3.17% / +12.3% — true minus sign, fewer decimals once large. */
export function pct(v: number | null | undefined, opts: { sign?: boolean, digits?: number } = {}) {
  if (v == null || Number.isNaN(v))
    return '—'
  const { sign = true } = opts
  const abs = Math.abs(v)
  const digits = opts.digits ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2)
  const body = abs.toFixed(digits)
  if (Number(body) === 0)
    return `${(0).toFixed(digits)}%`
  return `${v < 0 ? MINUS : sign ? '+' : ''}${body}%`
}

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })

export function price(v: number) {
  if (v < 1)
    return v.toFixed(4)
  return grouped.format(v)
}

/** Chinese money units: 5.25 万亿 / 544.7 亿 / 3,210 万. */
export function money(v: number) {
  if (!v)
    return '—'
  if (v >= 1e12)
    return `${(v / 1e12).toFixed(v >= 1e13 ? 1 : 2)} 万亿`
  if (v >= 1e8)
    return `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 亿`
  if (v >= 1e4)
    return `${Math.round(v / 1e4).toLocaleString('en-US')} 万`
  return Math.round(v).toLocaleString('en-US')
}

export function count(n: number) {
  return n.toLocaleString('en-US')
}

const etTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const bjTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const etDay = new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' })

export const timeET = (t: number) => etTime.format(t)
export const timeBJ = (t: number) => bjTime.format(t)
export const dayET = (t: number) => etDay.format(t)

export function duration(minutes: number) {
  if (minutes < 60)
    return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} 天${h % 24 ? ` ${h % 24} 小时` : ''}`
  }
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}
